import type { HeaderPinPlan, SwapReport } from './types.ts';
/**
 * 引脚网络重排 扩展入口 / Entry
 *
 * 主场在 PCB：选中 PCB 网络（如 MCU-FPGA 排线网络）→ 菜单「交换选中网络」
 * → 从网络连接的器件中选择实施交换的器件（排插/MCU/FPGA 均可）→
 * 求解最小交叉鼠线指派 → 应用 = 直接改该器件焊盘网络（画布鼠线即预览）
 * → 满意后「同步到原理图」，不满意「撤销」。原理图只跟进、不发起。
 */
import {
	applyDeviceToPcb,
	collectBoardState,
	createEdaHooks,
	createPcbHooks,
	loadConfig,
	loadLedger,
	loadReport,
	readSelectedPcbNets,
	storeReport,
	syncReportToSch,
	undoSwapLedger,
} from './eda-adapter.ts';
import { solveHeaderSwap } from './solver.ts';
import { buildDevicePinsPlan } from './stub-model.ts';

declare const eda: any;

/* 版本标记：扩展加载即写入，供桥接诊断直接确认客户端实际加载的版本 */
try {
	eda.sys_Storage?.setExtensionUserConfig?.('schHeaderSwapVersion', '0.3.1');
}
catch { /* ignore */ }

/* ---------------- 对话框封装 ---------------- */

function askConfirm(content: string, title: string): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, '确定', '取消', (main: boolean) => resolve(main));
	});
}

function info(content: string, title: string): void {
	eda.sys_Dialog.showInformationMessage(content, title);
}

/**
 * V3.2 的 ESYS_ToastMessageType 是数字枚举：0=错误 1=警告 2=信息 3=成功
 * （v4 才改字符串枚举）——传 0 会显示红圈红叉错误图标（solder-link 同款坑）
 */
function toast(msg: string, kind: 'info' | 'success' = 'info'): void {
	eda.sys_ToastMessage.showMessage(msg, kind === 'success' ? 3 : 2);
}

/* ---------------- 主流程：分析选中网络 ---------------- */

/** 组装单个器件的求解输入并回填 newNet（纯数据搬运，便于测试） */
export function solveForDevice(
	deviceDesignator: string,
	pins: HeaderPinPlan[],
	boardPads: Array<{ designator: string; padNumber: string; net: string; x: number; y: number; padId?: string }>,
	weightMode: 'crossings' | 'balanced' | 'length',
	maxRefineIters: number,
): { metricsBefore: { totalLengthMil: number; crossings: number }; metricsAfter: { totalLengthMil: number; crossings: number }; changedCount: number; swappableCount: number } {
	const swappable = pins.filter(p => p.swappable && p.pad);
	const padKey = (p: { padId?: string; designator: string; padNumber: string }) => p.padId ?? `${p.designator}.${p.padNumber}`;
	const slotKeys = new Set(swappable.map(p => padKey(p.pad!)));
	const slots = swappable.map(p => ({ pad: p.pad!, net: p.oldNet }));
	const nets = swappable.map(p => ({
		net: p.oldNet,
		// 其它端点 = 同网络全板焊盘，但排除本器件参与交换的焊盘（其余器件焊盘全保留在点集内）
		others: boardPads.filter(b => b.net === p.oldNet && !slotKeys.has(padKey(b))),
	}));
	const result = solveHeaderSwap(slots, nets, boardPads, deviceDesignator, { weightMode, maxRefineIters });
	swappable.forEach((p, i) => {
		p.newNet = nets[result.assignment[i]].net;
	});
	return {
		metricsBefore: result.metricsBefore,
		metricsAfter: result.metricsAfter,
		changedCount: result.changedCount,
		swappableCount: swappable.length,
	};
}

/** 提取 + 求解 + 存报告（预览与应用共用） */
async function buildReport(onProgress?: (pct: number, msg: string) => void): Promise<SwapReport> {
	onProgress?.(5, '读取选中网络…');
	const nets = await readSelectedPcbNets();
	if (nets.length < 2)
		throw new Error('选中网络不足 2 个（请在 PCB 中点选/框选要交换网络的走线或焊盘——未布线时选焊盘）');

	onProgress?.(20, '读取全板焊盘与走线…');
	const board = await collectBoardState();

	const cfg = loadConfig();
	const notes = [...board.notes];
	if (typeof eda.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId !== 'function')
		notes.push('当前客户端无器件引脚接口（getAllPinsByPrimitiveId）：无法应用（请升级客户端）');
	if (typeof eda.sch_PrimitiveWire?.modify !== 'function')
		notes.push('当前客户端无 sch_PrimitiveWire.modify 接口：同步原理图时将退级为"删除导线+按原折线重建"');

	// 候选器件：在选中网络上落有 ≥2 个焊盘的器件
	const selectedSet = new Set(nets);
	const padCountByDevice = new Map<string, number>();
	for (const p of board.pads) {
		if (!selectedSet.has(p.net))
			continue;
		padCountByDevice.set(p.designator, (padCountByDevice.get(p.designator) ?? 0) + 1);
	}
	const candidates = [...padCountByDevice.entries()]
		.filter(([, n]) => n >= 2)
		.map(([d]) => d)
		.filter(d => d)
		.sort();
	if (!candidates.length)
		throw new Error('选中网络上没有落有 ≥2 个焊盘的器件（无法交换）');

	onProgress?.(45, `求解 ${candidates.length} 个候选器件…`);
	const plans = [];
	for (const device of candidates) {
		const pins = buildDevicePinsPlan(device, board.pads, selectedSet, cfg);
		const solved = solveForDevice(device, pins, board.pads, cfg.weightMode, cfg.maxRefineIters);
		plans.push({
			headerDesignator: device,
			pins,
			metricsBefore: solved.metricsBefore,
			metricsAfter: solved.metricsAfter,
			changedCount: solved.changedCount,
			swappableCount: solved.swappableCount,
		});
	}
	onProgress?.(95, '生成报告…');
	return {
		generatedAt: new Date().toISOString(),
		selectedNets: nets,
		plans,
		routedLengthMil: board.routedLengthMil,
		notes,
	};
}

/** 交换选中网络（主命令，只读不改画布） */
export async function runNetSwap(): Promise<void> {
	eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析选中网络…');
	try {
		const report = await buildReport((pct, msg) => eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		await storeReport(report);
		console.log(
			`[headerswap] 报告已生成：网络 ${report.selectedNets.join(',')}；候选器件 ${report.plans.map(p =>
				`${p.headerDesignator}（可换 ${p.swappableCount}/交换 ${p.changedCount}，交叉 ${p.metricsBefore.crossings}->${p.metricsAfter.crossings}）`).join('、')}`
				+ `${report.notes.length ? `；注意：${report.notes.join('；')}` : ''}`,
		);
		await eda.sys_IFrame.openIFrame('/iframe/preview.html', 780, 660, 'headerswap-preview', {
			maximizeButton: false,
			minimizeButton: true,
			title: '引脚网络重排预览',
		});
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`分析失败：${e instanceof Error ? e.message : String(e)}\n\n提示：本命令在 PCB 编辑器中使用——先选中要交换的网络（点选/框选走线或焊盘），再执行本命令。`, '引脚网络重排');
	}
}

/* ---------------- 应用 / 同步 / 撤销 ---------------- */

function routedWarningsOf(report: SwapReport, device: string): string[] {
	const plan = report.plans.find(p => p.headerDesignator === device);
	if (!plan)
		return [];
	const affected = new Set(plan.pins.filter(x => x.swappable && x.newNet !== x.oldNet).map(x => x.oldNet));
	return [...affected].filter(n => (report.routedLengthMil[n] ?? 0) > 0).map(n => `${n}（已有走线约 ${Math.round((report.routedLengthMil[n] ?? 0) / 10) / 100}mm）`);
}

/** 把所选器件的方案应用到 PCB 焊盘（预览窗按钮经 MessageBus 调用，也可直接调用） */
export async function applyNetSwapDevice(device?: string): Promise<void> {
	try {
		const report = loadReport();
		if (!report || !report.plans.length) {
			info('没有已生成的方案。请先在 PCB 中选中网络并执行「交换选中网络」。', '应用交换');
			return;
		}
		if (report.appliedPcb) {
			info('当前方案已应用过。请先「同步到原理图」收尾，或「撤销上次交换」后重新分析。', '应用交换');
			return;
		}
		const chosen = device && report.plans.some(p => p.headerDesignator === device)
			? device
			: report.plans[0].headerDesignator;
		const plan = report.plans.find(p => p.headerDesignator === chosen)!;
		const changed = plan.pins.filter(x => x.swappable && x.newNet !== x.oldNet);
		if (!changed.length) {
			info(`器件 ${chosen} 没有可交换的引脚（可能全部被锁定，或排列已最优）。`, '应用交换');
			return;
		}

		const routed = routedWarningsOf(report, chosen);
		if (!(await askConfirm(
			`将在器件 ${chosen} 上交换 ${changed.length} 个引脚的网络（PCB 焊盘直接改写，保存后自动重开 PCB 页签刷新画布（鼠线即时可见）——不满意可「撤销上次交换」）。\n\n`
			+ `交叉 ${plan.metricsBefore.crossings} -> ${plan.metricsAfter.crossings}，鼠线总长 ${Math.round(plan.metricsBefore.totalLengthMil / 10) / 100}mm -> ${Math.round(plan.metricsAfter.totalLengthMil / 10) / 100}mm。\n${
				routed.length ? `\n⚠ 以下网络已有走线，交换后这些走线的网络归属将随焊盘变化：\n${routed.join('、')}\n` : ''
			}\n继续？`,
			'应用引脚交换',
		))) {
			return;
		}

		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '改写焊盘网络…');
		const cfg = loadConfig();
		const outcome = await applyDeviceToPcb(report, chosen, cfg, createPcbHooks(), (pct, msg) =>
			eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		report.chosenDevice = chosen;
		report.appliedPcb = true;
		await storeReport(report);
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		toast(`已应用到 PCB：改写焊盘 ${outcome.padsModified} 个${outcome.failedItems.length ? `，失败 ${outcome.failedItems.length} 项` : ''}`, 'success');
		info(
			`已应用到 PCB：改写 ${chosen} 的 ${outcome.padsModified} 个焊盘网络${outcome.failedItems.length ? `（失败 ${outcome.failedItems.length} 项：${outcome.failedItems.slice(0, 10).join('、')}）` : ''}。\n\n`
			+ '下一步：\n· 观察画布鼠线——满意用菜单「同步到原理图」落地；\n· 不满意用「撤销上次交换」恢复后重选。\n\n'
			+ '注意：同步前原理图与 PCB 网络不一致属预期（以 PCB 为准），请尽快同步。',
			'应用引脚交换',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`应用失败：${e instanceof Error ? e.message : String(e)}`, '应用引脚交换');
	}
}

/** 同步上次交换到原理图（器件引脚独占导线改网络；非独占列手工清单） */
export async function syncLastSwapToSch(): Promise<void> {
	try {
		const report = loadReport();
		if (!report || !report.appliedPcb || !report.chosenDevice) {
			info('没有已应用到 PCB 的交换。请先执行「交换选中网络」并应用。', '同步到原理图');
			return;
		}
		if (report.schSynced) {
			info('当前交换已同步过原理图。', '同步到原理图');
			return;
		}
		if (!(await askConfirm(
			`将把器件 ${report.chosenDevice} 的引脚网络同步到原理图（该器件引脚的独占导线改网络；汇入结点/电源符号承载的引脚会列入手工清单）。继续？`,
			'同步到原理图',
		))) {
			return;
		}

		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '同步原理图…');
		const cfg = loadConfig();
		const outcome = await syncReportToSch(report, cfg, createEdaHooks(), (pct, msg) =>
			eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		report.schSynced = true;
		await storeReport(report);
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		toast(`已同步原理图：改写导线 ${outcome.wires} 条${outcome.manual.length ? `，${outcome.manual.length} 项需手动处理` : ''}`, 'success');
		info(
			`已同步原理图：改写导线 ${outcome.wires} 条。${
				outcome.manual.length ? `\n\n以下引脚无法自动改写，请手动处理：\n${outcome.manual.slice(0, 30).join('\n')}${outcome.manual.length > 30 ? `\n…共 ${outcome.manual.length} 项` : ''}` : ''
			}\n\n如整体反悔，仍可用「撤销上次交换」一并恢复 PCB 与原理图。`,
			'同步到原理图',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`同步失败：${e instanceof Error ? e.message : String(e)}`, '同步到原理图');
	}
}

/** 撤销上次交换（PCB 焊盘 + 已同步过的原理图导线一并恢复） */
export async function undoLastSwap(): Promise<void> {
	try {
		const ledger = loadLedger();
		if (!ledger || !(ledger.padMods.length || ledger.wireMods.length)) {
			info('没有可撤销的交换记录。', '撤销上次交换');
			return;
		}
		if (!(await askConfirm(
			`将恢复器件 ${ledger.device} 的 ${ledger.padMods.length} 个 PCB 焊盘${ledger.wireMods.length ? `、${ledger.wireMods.length} 条原理图导线` : ''}的旧网络。继续？`,
			'撤销上次交换',
		))) {
			return;
		}

		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '撤销…');
		const r = await undoSwapLedger(ledger, createPcbHooks(), createEdaHooks(), (pct, msg) =>
			eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		// 报告复位：撤销后 PCB 回到分析时状态，允许重新应用
		const report = loadReport();
		if (report) {
			report.appliedPcb = false;
			report.chosenDevice = undefined;
			report.schSynced = false;
			await storeReport(report);
		}
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		toast(`已恢复焊盘 ${r.pads} 个${r.wires ? `、导线 ${r.wires} 条` : ''}${r.failed.length ? `，失败 ${r.failed.length} 项` : ''}`, 'success');
		if (r.failed.length)
			info(`部分恢复失败：\n${r.failed.slice(0, 20).join('、')}`, '撤销上次交换');
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`撤销失败：${e instanceof Error ? e.message : String(e)}`, '撤销上次交换');
	}
}

/* ---------------- 设置与关于 ---------------- */

function configSummary(cfg: ReturnType<typeof loadConfig>): string {
	return [
		`锁定引脚：${cfg.lockPins || '（空）'}`,
		`电源/地名单：${cfg.powerPatterns}`,
		`优化目标：${{ crossings: '偏重减少交叉', balanced: '均衡（交叉与线长）', length: '偏重缩短线长' }[cfg.weightMode]}`,
		`精修轮数上限：${cfg.maxRefineIters}`,
	].join('\n');
}

export async function openSettingsPanel(): Promise<void> {
	await eda.sys_IFrame.openIFrame('/iframe/settings.html', 560, 520, 'headerswap-settings', {
		maximizeButton: false,
		minimizeButton: true,
		title: '引脚网络重排设置',
	});
}

export function about(): void {
	const cfg = loadConfig();
	info(
		'引脚网络重排（lceda-sch-header-swap）\n\n'
		+ '在 PCB 中选中要交换的网络（如 MCU-FPGA 排线网络），从网络连接的器件中选择实施交换的器件（排插/MCU/FPGA 均可），按鼠线交叉与总线长求最优引脚-网络指派（匈牙利算法 + 2-opt 精修）；应用后直接改焊盘网络，画布鼠线即时可见，满意再同步原理图，不满意一键撤销。\n\n'
		+ '用法要点：\n- 交换的目的是好布线：PCB 为主场，原理图只跟进\n- 交换发生在同一批选中的网络内部，器件其它引脚不受影响\n- 引脚需由"带网络名的导线"连接才可自动同步原理图\n- 电源/地脚默认锁定，任意引脚可在设置中锁定\n\n'
		+ `当前配置：\n${configSummary(cfg)}`,
		'关于',
	);
}

/* ---------------- 预览窗口 -> 入口 的应用命令通道 ---------------- */

/**
 * 预览 iframe 的「应用」按钮经 sys_MessageBus 发命令到入口执行
 * （eext-netlist-explorer 同款思路）。MessageBus 不可用时预览窗会
 * 引导用户用菜单命令。入口脚本在扩展激活时常驻，这里顶层注册一次。
 */
try {
	if (typeof eda?.sys_MessageBus?.pull === 'function') {
		eda.sys_MessageBus.pull('header-swap-cmd', async (msg: any) => {
			try {
				const cmd = typeof msg === 'string' ? JSON.parse(msg) : msg;
				if (cmd?.cmd === 'apply')
					await applyNetSwapDevice(typeof cmd.device === 'string' ? cmd.device : undefined);
			}
			catch (e) {
				console.warn('[headerswap] 处理预览窗口命令失败:', e);
			}
		});
	}
}
catch (e) {
	console.warn('[headerswap] MessageBus 注册失败（预览窗应用按钮将引导菜单路径）:', e);
}
