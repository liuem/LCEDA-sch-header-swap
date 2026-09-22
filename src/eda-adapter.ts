import type { PageNetFlag, PagePinRef, PageWire } from './stub-model.ts';
/**
 * EDA 运行时适配层 / EDA runtime adapter
 *
 * 主场在 PCB（交换的目的是好布线）：
 * - PCB 侧读取：选中网络、全板焊盘、走线长度（PCB 激活时直接读，无需跨文档）
 * - 应用 = 直接改器件焊盘网络（保存 + 刷新鼠线，画布鼠线即预览）
 * - 同步 = 跨文档找到器件所在原理图页，把该器件引脚独占导线的网络改为新网络
 * - 撤销 = 按台账反向恢复（先 PCB 焊盘，再原理图导线）
 *
 * 写回操作通过 hooks 注入（生产包装全局 eda，测试注入模拟实现）。
 * 坐标单位：原理图 1 单位 = 10mil；PCB 为 mil。
 */
import type { HeaderSwapConfig, Pad, SchHeader, SwapReport } from './types.ts';
import { pointOnSegment, wireVertices } from './geometry.ts';
import { DEFAULT_CONFIG } from './types.ts';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 鼠线计算 settle 等待：大板要秒级，过早 stop 掐死计算（离线测试调小加速） */
let ratlineSettleMs = 2500;
export function setRatlineSettleMs(ms: number): void {
	ratlineSettleMs = Math.max(0, ms);
}

/** 全局 eda 对象由扩展运行时注入 */
declare const eda: any;

/* ------------------------- 存储键 ------------------------- */

const CONFIG_KEY = 'schHeaderSwapConfig';
const REPORT_KEY = 'schHeaderSwapLastPlan';
const LEDGER_KEY = 'schHeaderSwapLedger';

/* ------------------------- 配置存取 ------------------------- */

export function loadConfig(): HeaderSwapConfig {
	let saved = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	if (typeof saved === 'string' && saved.trim().startsWith('{')) {
		try {
			saved = JSON.parse(saved);
		}
		catch { /* 保持原值 */ }
	}
	const cfg = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
	if (!['crossings', 'balanced', 'length'].includes(cfg.weightMode))
		cfg.weightMode = 'balanced';
	if (!Number.isFinite(cfg.maxRefineIters) || cfg.maxRefineIters < 0)
		cfg.maxRefineIters = DEFAULT_CONFIG.maxRefineIters;
	if (!Number.isFinite(cfg.createIntervalMs) || cfg.createIntervalMs < 0)
		cfg.createIntervalMs = DEFAULT_CONFIG.createIntervalMs;
	if (!Number.isFinite(cfg.maxRetries) || cfg.maxRetries < 0)
		cfg.maxRetries = DEFAULT_CONFIG.maxRetries;
	cfg.lockPins = String(cfg.lockPins ?? '');
	cfg.powerPatterns = String(cfg.powerPatterns ?? DEFAULT_CONFIG.powerPatterns);
	return cfg;
}

export async function saveConfig(cfg: HeaderSwapConfig): Promise<boolean> {
	await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, JSON.stringify(cfg));
	const back = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	return typeof back === 'string' && back.includes('"weightMode"');
}

function readStorageJson(key: string): any {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(key);
		return typeof raw === 'string' ? JSON.parse(raw) : raw;
	}
	catch {
		return undefined;
	}
}

async function writeStorageJson(key: string, value: unknown): Promise<void> {
	await eda.sys_Storage.setExtensionUserConfig(key, JSON.stringify(value));
}

/* ------------------------- 原理图页读取 ------------------------- */

/** 读取选中器件（普通器件 'part'；只选引脚时反查父器件）——诊断/辅助用 */
export async function getSelectedHeaders(): Promise<SchHeader[]> {
	const selected = (await eda.sch_SelectControl.getAllSelectedPrimitives()) ?? [];
	const compPrims: any[] = [];
	const pinPrims: any[] = [];
	for (const p of selected) {
		try {
			const t = p.getState_PrimitiveType?.();
			if (t === 'Component')
				compPrims.push(p);
			else if (t === 'ComponentPin')
				pinPrims.push(p);
		}
		catch { /* 单个失败跳过 */ }
	}

	if (!compPrims.length && pinPrims.length) {
		const pinIds = new Set(pinPrims.map(p => String(p.getState_PrimitiveId?.() ?? '')));
		const all = await schAllComponents();
		for (const c of all) {
			try {
				const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId())) ?? [];
				if (pins.some((pin: any) => pinIds.has(String(pin.getState_PrimitiveId?.() ?? '')))) {
					compPrims.push(c);
					if (compPrims.length >= pinIds.size)
						break;
				}
			}
			catch { /* ignore */ }
		}
	}

	const headers: SchHeader[] = [];
	for (const p of compPrims) {
		try {
			const ctype = p.getState_ComponentType?.();
			if (ctype && ctype !== 'part')
				continue;
			const designator = String(p.getState_Designator?.() ?? '').trim();
			const id = String(p.getState_PrimitiveId?.() ?? '');
			if (!designator || !id)
				continue;
			const rawPins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) ?? [];
			const pins = rawPins.map((pin: any) => ({
				pinNumber: String(pin.getState_PinNumber?.() ?? '').trim(),
				pinName: String(pin.getState_PinName?.() ?? '').trim(),
				x: Number(pin.getState_X?.()),
				y: Number(pin.getState_Y?.()),
				noConnect: pin.getState_NoConnected?.() === true,
			})).filter((pin: any) => Number.isFinite(pin.x) && Number.isFinite(pin.y));
			headers.push({ primitiveId: id, designator, pins });
		}
		catch (e) {
			console.warn('[headerswap] 读取选中器件失败:', e);
		}
	}
	return headers;
}

/** 当前页导线：id / 折线 / 自带网络名 / sch_Net 权威名 */
export async function readPageWires(): Promise<PageWire[]> {
	// 权威网络名映射（wire ID -> 全局网络名），与 conn-export 同口径
	const authNetByWireId = new Map<string, string>();
	try {
		const perSch = (await eda.sch_Net?.getCurrentProjectAllNets?.()) ?? [];
		for (const sch of perSch) {
			for (const net of sch?.nets ?? []) {
				for (const wire of net?.wires ?? []) {
					const id = String(wire?.id ?? '');
					if (id && !authNetByWireId.has(id))
						authNetByWireId.set(id, String(net?.net ?? wire?.globalNetName ?? '').trim());
				}
			}
		}
	}
	catch (e) {
		console.warn('[headerswap] sch_Net 全局网络名读取失败（退回导线自带名）:', e);
	}

	const wires: PageWire[] = [];
	try {
		const prims = (await eda.sch_PrimitiveWire.getAll?.()) ?? [];
		for (const w of prims) {
			try {
				const id = String(w.getState_PrimitiveId?.() ?? '');
				const line = w.getState_Line?.();
				const vertices = wireVertices(line);
				if (!id || vertices.length < 2)
					continue;
				const flat = typeof line?.[0] === 'number'
					? (line as number[]).map(Number)
					: vertices.flatMap(v => [Math.round(v.x), Math.round(v.y)]);
				wires.push({
					id,
					line: flat,
					vertices,
					ownNet: String(w.getState_Net?.() ?? '').trim(),
					authNet: authNetByWireId.get(id) ?? '',
				});
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[headerswap] 导线读取失败:', e);
	}
	return wires;
}

/** 当前页电源/地符号（netflag 是 Component 图元） */
export async function readPageNetFlags(): Promise<PageNetFlag[]> {
	const flags: PageNetFlag[] = [];
	try {
		const prims = (await eda.sch_PrimitiveComponent.getAll?.('netflag')) ?? [];
		for (const f of prims) {
			try {
				const id = String(f.getState_PrimitiveId?.() ?? '');
				const net = String(f.getState_Net?.() ?? '').trim();
				const x = Number(f.getState_X?.());
				const y = Number(f.getState_Y?.());
				if (id && net && Number.isFinite(x) && Number.isFinite(y))
					flags.push({ id, net, x, y });
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[headerswap] 电源符号读取失败:', e);
	}
	return flags;
}

/** 当前页全部普通器件引脚（簇成员判定用） */
export async function readPagePins(): Promise<PagePinRef[]> {
	const pins: PagePinRef[] = [];
	try {
		const comps = await schAllComponents();
		for (const c of comps) {
			try {
				const ctype = c.getState_ComponentType?.();
				if (ctype && ctype !== 'part')
					continue;
				const designator = String(c.getState_Designator?.() ?? '').trim();
				if (!designator)
					continue;
				const rawPins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId())) ?? [];
				for (const pin of rawPins) {
					const x = Number(pin.getState_X?.());
					const y = Number(pin.getState_Y?.());
					if (Number.isFinite(x) && Number.isFinite(y))
						pins.push({ designator, pinNumber: String(pin.getState_PinNumber?.() ?? '').trim(), x, y });
				}
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[headerswap] 器件引脚读取失败:', e);
	}
	return pins;
}

/* ------------------------- PCB 侧读取（PCB 激活时直接读） ------------------------- */

/** 读取当前选中的 PCB 网络（点选/框选走线、焊盘、过孔皆可） */
export async function readSelectedPcbNets(): Promise<string[]> {
	const nets = new Set<string>();
	try {
		const prims = (await eda.pcb_SelectControl?.getAllSelectedPrimitives?.()) ?? [];
		for (const p of prims) {
			try {
				const net = String(p.getState_Net?.() ?? '').trim();
				if (net)
					nets.add(net);
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[headerswap] 选中图元读取失败:', e);
	}
	return [...nets].sort();
}

export interface BoardState {
	pads: Pad[];
	routedLengthMil: Record<string, number>;
	pcb: { uuid: string; tabId?: string; label: string };
	notes: string[];
}

/** 递归收集工程信息里的 PCB 文档（兼容 board.pcb 与独立 pcb 项两种形态） */
function collectPcbItems(node: any, out: Array<{ uuid: string; label: string }>): void {
	if (Array.isArray(node)) {
		node.forEach(item => collectPcbItems(item, out));
		return;
	}
	if (!node || typeof node !== 'object')
		return;
	if (node.pcb?.uuid)
		out.push({ uuid: String(node.pcb.uuid), label: String(node.name ?? node.pcb.name ?? 'PCB') });
	else if (/^pcb$/i.test(String(node.type ?? '')) && node.uuid)
		out.push({ uuid: String(node.uuid), label: String(node.name ?? 'PCB') });
	for (const v of Object.values(node))
		collectPcbItems(v, out);
}

/** 递归收集工程信息里的原理图页（兼容 board.schematic 子对象与独立 schematic/page 项） */
function collectSchPageItems(node: any, out: string[]): void {
	if (Array.isArray(node)) {
		node.forEach(item => collectSchPageItems(item, out));
		return;
	}
	if (!node || typeof node !== 'object')
		return;
	const schNode = node.schematic ?? (/^schematic$/i.test(String(node.type ?? '')) ? node : null);
	if (schNode?.uuid) {
		out.push(String(schNode.uuid));
		// pages 为复数数组；部分工程是单数 page 字段（实机 V3.2 见过）
		const pageList = schNode.pages ?? (schNode.page != null ? [].concat(schNode.page) : []);
		for (const p of pageList) {
			if (p?.uuid)
				out.push(String(p.uuid));
		}
	}
	if (/^page$/i.test(String(node.type ?? '')) && node.uuid)
		out.push(String(node.uuid));
	for (const v of Object.values(node))
		collectSchPageItems(v, out);
}

/** 当前活动文档信息 */
export async function getCurrentDoc(): Promise<{ uuid: string; tabId?: string; type?: string } | undefined> {
	try {
		const cur = await eda.dmt_SelectControl?.getCurrentDocumentInfo?.();
		if (cur?.uuid)
			return { uuid: String(cur.uuid), tabId: cur.tabId ? String(cur.tabId) : undefined, type: String(cur.documentType ?? '') };
	}
	catch { /* 可选 */ }
	return undefined;
}

/** 打开并激活指定文档（原理图页 / PCB 通吃） */
export async function activateDoc(uuid: string, tabId?: string): Promise<void> {
	try {
		const tab = await eda.dmt_EditorControl.openDocument(uuid);
		await eda.dmt_EditorControl.activateDocument(tabId ?? tab?.tabId ?? tab);
	}
	catch (e) {
		console.warn(`[headerswap] 激活文档 ${uuid} 失败:`, e);
	}
}

/**
 * 读全板状态（需 PCB 处于激活状态——主命令从 PCB 菜单发起，天然满足）。
 */
export async function collectBoardState(): Promise<BoardState> {
	const notes: string[] = [];
	const cur = await getCurrentDoc();
	const info = await eda.dmt_Project?.getCurrentProjectInfo?.();
	if (!info)
		throw new Error('读取工程信息失败（dmt_Project.getCurrentProjectInfo 不可用或返回空）');

	// PCB 上下文：优先当前活动文档（用户正编辑的板），否则取工程内唯一/首个 PCB
	const pcbItems: Array<{ uuid: string; label: string }> = [];
	collectPcbItems(info.data, pcbItems);
	let chosen = cur?.uuid ? pcbItems.find(p => p.uuid === cur.uuid) : undefined;
	if (!chosen) {
		if (!pcbItems.length)
			throw new Error('工程中未找到 PCB 文档（请确认当前工程包含 PCB）');
		chosen = pcbItems.sort((a, b) => a.label.localeCompare(b.label))[0];
		if (pcbItems.length > 1)
			notes.push(`工程含 ${pcbItems.length} 个 PCB，使用「${chosen.label}」（多 PCB 选择待后续版本支持）`);
	}
	if (cur && cur.uuid !== chosen.uuid)
		notes.push('当前活动文档不是所选 PCB，请先打开/激活对应 PCB 再运行（焊盘读取以激活文档为准）');

	// 器件 ID -> 位号
	const compName = new Map<string, string>();
	const comps = (await eda.pcb_PrimitiveComponent.getAll?.()) ?? [];
	for (const c of comps) {
		try {
			compName.set(String(c.getState_PrimitiveId?.() ?? ''), String(c.getState_Designator?.() ?? '').trim());
		}
		catch { /* ignore */ }
	}

	// 全板焊盘（绝对坐标 mil，已含器件旋转）
	const pads: Pad[] = [];
	const padPrims = (await eda.pcb_PrimitivePad.getAll?.()) ?? [];
	// 焊盘->器件位号映射双路径：部分客户端的 pad 自带 getState_ParentComponentPrimitiveId
	// （autofanout 实机先例）；V3.2 实测 pad.getAll 返回的图元没有该方法——此时用
	// 器件引脚（getAllPinsByPrimitiveId 的返回带 parent + net + 坐标）反向建映射。
	const padHasParent = typeof padPrims[0]?.getState_ParentComponentPrimitiveId === 'function';
	const padIdToDes = new Map<string, string>();
	if (!padHasParent) {
		const CONCURRENCY = 8;
		for (let i = 0; i < comps.length; i += CONCURRENCY) {
			const batch = comps.slice(i, i + CONCURRENCY);
			const pinsList = await Promise.all(batch.map((c: any) =>
				eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId?.()).catch(() => []),
			));
			batch.forEach((c: any, bi: number) => {
				const des = String(c.getState_Designator?.() ?? '').trim();
				for (const pin of pinsList[bi] ?? []) {
					try {
						const pid = String(pin.getState_PrimitiveId?.() ?? '');
						if (pid)
							padIdToDes.set(pid, des);
					}
					catch { /* ignore */ }
				}
			});
		}
		notes.push(`焊盘位号经器件引脚映射（${padIdToDes.size} 焊盘/${comps.length} 器件）`);
	}
	for (const p of padPrims) {
		try {
			const padId = String(p.getState_PrimitiveId?.() ?? '');
			const x = Number(p.getState_X?.());
			const y = Number(p.getState_Y?.());
			if (!padId || !Number.isFinite(x) || !Number.isFinite(y))
				continue;
			const parentId = padHasParent ? String(p.getState_ParentComponentPrimitiveId?.() ?? '') : '';
			pads.push({
				designator: compName.get(parentId) ?? padIdToDes.get(padId) ?? '',
				padNumber: String(p.getState_PadNumber?.() ?? '').trim(),
				net: String(p.getState_Net?.() ?? '').trim(),
				x,
				y,
				padId,
			});
		}
		catch { /* ignore */ }
	}
	if (!pads.length)
		throw new Error('PCB 焊盘读取为空（pcb_PrimitivePad.getAll 返回空——若当前文档不是 PCB，请先激活 PCB）');
	const unmapped = pads.filter(p => !p.designator).length;
	if (unmapped > 0)
		notes.push(`${unmapped} 个焊盘未解析到位号（不参与交换）`);

	// 各网络已有走线长度（守卫数据；失败不致命）
	const routedLengthMil: Record<string, number> = {};
	try {
		const lines = (await eda.pcb_PrimitiveLine.getAll?.()) ?? [];
		for (const ln of lines) {
			try {
				const net = String(ln.getState_Net?.() ?? '').trim();
				if (!net)
					continue;
				const len = Math.hypot(
					Number(ln.getState_EndX?.()) - Number(ln.getState_StartX?.()),
					Number(ln.getState_EndY?.()) - Number(ln.getState_StartY?.()),
				);
				if (Number.isFinite(len))
					routedLengthMil[net] = (routedLengthMil[net] ?? 0) + len;
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		notes.push('走线长度读取失败（不影响预览，仅少了应用前警告）');
		console.warn('[headerswap] 走线读取失败:', e);
	}

	return { pads, routedLengthMil, pcb: { uuid: chosen.uuid, tabId: cur?.uuid === chosen.uuid ? cur.tabId : undefined, label: chosen.label }, notes };
}

/* ------------------------- 跨文档：定位器件所在原理图页 ------------------------- */

export interface FoundSchPage {
	pageUuid: string;
	tabId?: string;
	/** 器件 primitive 对象（后续读引脚用） */
	comp: any;
}

/**
 * sch 器件读取统一入口：V3.2 实机无参 getAll() 必抛「获取所有器件失败」，
 * 可用形态是 getAll('part', true)（conn-export 先例）；旧客户端不支持带参时退级。
 * 注意 ('part', true) 在 V3.2 返回跨图页集合——需要"器件所在页"语义时由调用方
 * 自行做页归属确认。
 */
async function schAllComponents(): Promise<any[]> {
	try {
		const a = await eda.sch_PrimitiveComponent.getAll?.('part', true);
		if (Array.isArray(a))
			return a;
	}
	catch { /* 退级再试 */ }
	try {
		const b = await eda.sch_PrimitiveComponent.getAll?.('part');
		if (Array.isArray(b))
			return b;
	}
	catch { /* 退级再试 */ }
	return (await eda.sch_PrimitiveComponent.getAll?.()) ?? [];
}

/** 器件是否在当前激活页：引脚落在本页任一导线段上（同步场景器件必有导线连接） */
async function compOnActivePage(comp: any): Promise<boolean> {
	try {
		const wires = (await eda.sch_PrimitiveWire.getAll?.()) ?? [];
		const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(comp.getState_PrimitiveId?.())) ?? [];
		for (const pin of pins) {
			const px = Number(pin.getState_X?.());
			const py = Number(pin.getState_Y?.());
			if (!Number.isFinite(px) || !Number.isFinite(py))
				continue;
			for (const w of wires) {
				const vs = wireVertices(w.getState_Line?.());
				for (let i = 0; i + 1 < vs.length; i++) {
					if (pointOnSegment(px, py, vs[i].x, vs[i].y, vs[i + 1].x, vs[i + 1].y))
						return true;
				}
			}
		}
	}
	catch { /* 读不到导线/引脚时不做页确认（返回 false 走退级） */ }
	return false;
}

/**
 * 在工程原理图页中定位器件：逐页打开激活 + 读器件表比对位号。
 * 页清单来自工程信息（schematic 节点 + pages 列表），形态未知时至少
 * 尝试 schematic 节点本身。
 */
export async function findSchPageWithDevice(designator: string): Promise<FoundSchPage> {
	const info = await eda.dmt_Project?.getCurrentProjectInfo?.();
	if (!info)
		throw new Error('读取工程信息失败（无法定位原理图页）');
	const pageUuids: string[] = [];
	collectSchPageItems(info.data, pageUuids);
	const unique = [...new Set(pageUuids)];
	if (!unique.length)
		throw new Error('工程信息中未发现原理图页（请先手动打开器件所在原理图页后重试）');

	// V3.2 的 ('part', true) 跨图页返回——单页工程命中即所在页；多页需几何确认
	// 器件真在当前激活页（同步要改的是该页导线），确认不了退级到首次命中页。
	let firstSeen: FoundSchPage | undefined;

	for (const uuid of unique) {
		try {
			const tab = await eda.dmt_EditorControl.openDocument(uuid);
			await eda.dmt_EditorControl.activateDocument(tab?.tabId ?? tab);
			const comps = await schAllComponents();
			for (const c of comps) {
				try {
					if (String(c.getState_Designator?.() ?? '').trim() !== designator)
						continue;
					const entry: FoundSchPage = { pageUuid: uuid, tabId: tab?.tabId ? String(tab.tabId) : undefined, comp: c };
					if (unique.length === 1 || await compOnActivePage(c))
						return entry;
					firstSeen ??= entry;
				}
				catch { /* ignore */ }
			}
		}
		catch (e) {
			console.warn(`[headerswap] 打开原理图页 ${uuid} 失败:`, e);
		}
	}
	if (firstSeen)
		return firstSeen;
	throw new Error(`未在工程原理图中找到器件 ${designator}（请确认位号；或先手动打开其所在图页再重试）`);
}

/* ------------------------- 写回 hooks ------------------------- */

export interface SchApplyHooks {
	readWireNet: (wireId: string) => Promise<string | undefined>;
	modifyWireNet: (wireId: string, net: string) => Promise<boolean>;
	deleteWires: (ids: string[]) => Promise<boolean>;
	createWire: (line: number[], net: string) => Promise<string | undefined>;
}

export interface PcbApplyHooks {
	modifyPadNet: (padId: string, net: string) => Promise<boolean>;
	savePcb: () => Promise<boolean>;
	/**
	 * 写后刷新画布。V3.2 实测（2026-09-22）：程序化改焊盘网络（setState+done 或
	 * 类级 modify）会把交互层带进半成品事务态——只有被改焊盘可拖、拖动不落盘、
	 * 鼠线不重算；**关闭再打开 PCB 页签即原生重建**（用户手动路径验证）。主路径
	 * = 关开页签；关开不可用时退级 ratline start/stop 循环。
	 */
	refreshPcbCanvas: (pcbUuid: string, tabId?: string) => Promise<void>;
	/**
	 * 写画布前清空选中（修改"正处于选中状态"的焊盘会把交互层搞坏：该焊盘
	 * 卡在可拖动/旋转的编辑态、其它图元全部无法选中——V3.2 实机复现）
	 */
	clearSelection: () => Promise<void>;
}

/** 生产原理图 hooks：modify 为主，读回校验 */
export function createEdaHooks(): SchApplyHooks {
	return {
		async readWireNet(wireId) {
			try {
				const got = await eda.sch_PrimitiveWire.get?.([wireId]);
				const w = Array.isArray(got) ? got[0] : got;
				return String(w?.getState_Net?.() ?? '').trim();
			}
			catch {
				return undefined;
			}
		},
		async modifyWireNet(wireId, net) {
			try {
				const r = await eda.sch_PrimitiveWire.modify?.(wireId, { net });
				if (r === false)
					return false;
				const got = await eda.sch_PrimitiveWire.get?.([wireId]);
				const w = Array.isArray(got) ? got[0] : got;
				const now = String(w?.getState_Net?.() ?? '').trim();
				return now === net;
			}
			catch (e) {
				console.warn(`[headerswap] 导线 ${wireId} 改网络失败:`, e);
				return false;
			}
		},
		async deleteWires(ids) {
			if (!ids.length)
				return true;
			return !!await eda.sch_PrimitiveWire.delete(ids);
		},
		async createWire(line, net) {
			const w = await eda.sch_PrimitiveWire.create(line, net);
			return w?.getState_PrimitiveId?.();
		},
	};
}

/** 生产 PCB hooks：改焊盘网络/保存/刷新鼠线 */

/**
 * 全板引脚对象缓存（padId -> getAllPinsByPrimitiveId 返回的引脚对象）。
 * 写网络用引脚对象的 setState_Net + done（V3.2 实测真实生效且不破坏画布交互层）；
 * 类级 pcb_PrimitivePad.modify 虽也生效，但批量调用会把交互层搞坏（画布只剩
 * 被改过的焊盘可点选，其余全部点不中——多轮实机复现），仅作旧客户端兜底。
 */
let pinObjCache: Map<string, any> | null = null;

export async function ensurePinObjCache(force = false): Promise<Map<string, any>> {
	if (pinObjCache && !force)
		return pinObjCache;
	const m = new Map<string, any>();
	const compApi = eda.pcb_PrimitiveComponent;
	const getAll = compApi?.getAll;
	const getPins = compApi?.getAllPinsByPrimitiveId;
	if (typeof getAll !== 'function' || typeof getPins !== 'function') {
		// 无器件引脚接口（极旧客户端）：留空缓存，写路径走类级 modify 兜底
		pinObjCache = m;
		return m;
	}
	const comps = (await getAll.call(compApi)) ?? [];
	const CONCURRENCY = 8;
	for (let i = 0; i < comps.length; i += CONCURRENCY) {
		const batch = comps.slice(i, i + CONCURRENCY);
		const pinsList = await Promise.all(batch.map((c: any) =>
			getPins.call(compApi, c.getState_PrimitiveId?.()).catch(() => []),
		));
		batch.forEach((_c: any, bi: number) => {
			for (const pin of pinsList[bi] ?? []) {
				try {
					const pid = String(pin.getState_PrimitiveId?.() ?? '');
					if (pid)
						m.set(pid, pin);
				}
				catch { /* ignore */ }
			}
		});
	}
	pinObjCache = m;
	return m;
}

/** 仅供测试：清空引脚对象缓存（跨 fixture 切换用） */
export function resetPinObjCache(): void {
	pinObjCache = null;
}

export function createPcbHooks(): PcbApplyHooks {
	return {
		async clearSelection() {
			try {
				await eda.pcb_SelectControl?.clearSelected?.();
			}
			catch { /* 清选失败不阻断（由写路径兜底） */ }
		},
		async modifyPadNet(padId, net) {
			try {
				// 主路径：引脚对象 setState_Net + done
				let pin = (await ensurePinObjCache()).get(padId);
				if (!pin) {
					pin = (await ensurePinObjCache(true)).get(padId);
				}
				if (pin && typeof pin.setState_Net === 'function') {
					pin.setState_Net(net);
					pin.done?.();
					return String(pin.getState_Net?.() ?? '') === net;
				}
				// 兜底：类级 modify（注意批量调用可能触发交互层问题，仅无 setState 时使用）
				const r = await eda.pcb_PrimitivePad.modify?.(padId, { net });
				return r !== false && r !== undefined;
			}
			catch (e) {
				console.warn(`[headerswap] 焊盘 ${padId} 改网络失败:`, e);
				return false;
			}
		},
		async savePcb() {
			try {
				await eda.pcb_Document?.save?.();
				return true;
			}
			catch (e) {
				console.warn('[headerswap] PCB 保存失败:', e);
				return false;
			}
		},
		async refreshPcbCanvas(pcbUuid: string, tabId?: string) {
			// 主路径：关开 PCB 页签——原生重建画布（交互层/鼠线一起干净）。
			// closeDocument 前必须已 save（未保存数据会直接丢弃，调用方保证）。
			// 注意：程序化重开会把鼠线计算模式置为 active（实测 before=inactive
			// ->after=active，且这正是重开能刷新鼠线的机制——它在重算），必须
			// 等计算完成（settle）后 stop 掉，否则画布停在锁死态、计算被掐死。
			try {
				const ec = eda.dmt_EditorControl;
				if (typeof ec?.closeDocument === 'function' && typeof ec?.openDocument === 'function') {
					const closed = await ec.closeDocument(tabId ?? pcbUuid).catch(() => false);
					const nt = await ec.openDocument(pcbUuid).catch(() => undefined);
					if (nt) {
						// openDocument 返回 tabId 字符串（类型标注）或 {tabId} 对象（部分客户端），两形态兼容
						await ec.activateDocument(typeof nt === 'string' ? nt : nt?.tabId).catch(() => { /* 已打开即可 */ });
						const doc = eda.pcb_Document;
						await sleep(ratlineSettleMs);
						await doc?.stopCalculatingRatline?.().catch(() => { /* 旧客户端无此模式 */ });
						for (let i = 0; i < 5; i++) {
							const s = String(await doc?.getCalculatingRatlineStatus?.() ?? 'inactive');
							if (s !== 'active')
								return;
							await doc?.stopCalculatingRatline?.().catch(() => { /* ignore */ });
							await sleep(200);
						}
						console.warn('[headerswap] 页签重开后鼠线计算未收敛到 inactive，请手动点击画布恢复正常');
						return;
					}
					console.warn(`[headerswap] 页签重开失败（closed=${closed}）——退级鼠线刷新，必要时请手动重开 PCB 页签`);
				}
			}
			catch { /* 退级 */ }
			// 退级路径：ratline start/stop。V3.2 实测：startCalculatingRatline 是
			// 模式开关（调后状态保持 active 且画布输入被锁死），必须与 stop 成对
			// 调用；大板计算要秒级，过早 stop 会把计算掐死。
			const doc = eda.pcb_Document;
			try {
				await doc?.startCalculatingRatline?.();
			}
			catch { /* 部分客户端无此接口，鼠线在交互后自行刷新 */ }
			try {
				await sleep(ratlineSettleMs);
				await doc?.stopCalculatingRatline?.();
				for (let i = 0; i < 5; i++) {
					const s = String(await doc?.getCalculatingRatlineStatus?.());
					if (s !== 'active')
						return;
					await doc?.stopCalculatingRatline?.();
					await sleep(200);
				}
				console.warn('[headerswap] 鼠线计算状态未收敛到 inactive，已多次尝试停止');
			}
			catch { /* 状态接口不可用则跳过校验 */ }
		},
	};
}

/* ------------------------- 自适应节奏（net-fanout 同款） ------------------------- */

/**
 * 自适应节奏控制器：起步 minPace；失败翻倍（封顶 1200ms）后重试；
 * 连续 4 次成功回落 30%。画布对密集写操作存在事务限流。
 */
export class AdaptivePacer {
	private pace: number;
	private streak = 0;
	private readonly minPace: number;
	private readonly maxPace: number;

	constructor(minPace: number, maxPace = 1200) {
		this.minPace = Math.max(0, minPace);
		this.maxPace = maxPace;
		this.pace = this.minPace;
	}

	onFail(): number {
		this.streak = 0;
		this.pace = Math.min(Math.max(this.pace, 100) * 2, this.maxPace);
		return this.pace;
	}

	onSuccess(): void {
		this.streak++;
		if (this.streak >= 4 && this.pace > this.minPace) {
			this.pace = Math.max(this.minPace, Math.round(this.pace * 0.7));
			this.streak = 0;
		}
	}

	current(): number {
		return this.pace;
	}
}

/* ------------------------- 报告/台账存取 ------------------------- */

export async function storeReport(report: SwapReport): Promise<void> {
	await writeStorageJson(REPORT_KEY, report);
}

export function loadReport(): SwapReport | undefined {
	const r = readStorageJson(REPORT_KEY);
	return r && typeof r === 'object' && Array.isArray(r.plans) ? r : undefined;
}

export interface LedgerWireMod {
	wireId: string;
	oldNet: string;
	newNet: string;
	/** 删建回退产生的新导线（撤销时删除重建原线） */
	recreated?: { newWireId: string; oldLine: number[] };
}

export interface SwapLedger {
	generatedAt: string;
	/** 实施交换的器件 */
	device: string;
	padMods: Array<{ padId: string; oldNet: string; newNet: string }>;
	wireMods: LedgerWireMod[];
	pcb: { uuid: string; tabId?: string; label: string };
	/** 同步过的原理图页（撤销时回到该页恢复导线） */
	schPage?: { uuid: string; tabId?: string };
}

export async function storeLedger(ledger: SwapLedger): Promise<void> {
	await writeStorageJson(LEDGER_KEY, ledger);
}

export function loadLedger(): SwapLedger | undefined {
	const l = readStorageJson(LEDGER_KEY);
	return l && typeof l === 'object' && Array.isArray(l.padMods) ? l : undefined;
}

export async function clearLedger(): Promise<void> {
	await eda.sys_Storage.setExtensionUserConfig(LEDGER_KEY, '');
}

/* ------------------------- 应用（PCB 焊盘） ------------------------- */

export interface ApplyPcbOutcome {
	padsModified: number;
	failedItems: string[];
	ledger: SwapLedger;
}

/**
 * 把所选器件的方案应用到 PCB 焊盘（当前 PCB 已激活）。
 * 台账在改动前落盘；焊盘网络直接逐个改（焊盘无导线那样的同页命名互斥问题），
 * 完成后保存 + 刷新鼠线——画布鼠线即预览。
 */
export async function applyDeviceToPcb(
	report: SwapReport,
	device: string,
	cfg: HeaderSwapConfig,
	pcbHooks: PcbApplyHooks,
	onProgress?: (pct: number, msg: string) => void,
): Promise<ApplyPcbOutcome> {
	const plan = report.plans.find(p => p.headerDesignator === device);
	if (!plan)
		throw new Error(`报告中没有器件 ${device} 的方案`);
	const attempts = Math.max(1, Math.round(cfg.maxRetries) + 1);
	const pacer = new AdaptivePacer(cfg.createIntervalMs);

	const changed = plan.pins.filter(p => p.swappable && p.newNet !== p.oldNet && p.pad?.padId);
	if (!changed.length)
		throw new Error(`器件 ${device} 没有需要交换的引脚`);

	const cur = await getCurrentDoc();
	const ledger: SwapLedger = {
		generatedAt: report.generatedAt,
		device,
		padMods: changed.map(p => ({ padId: p.pad!.padId!, oldNet: p.oldNet, newNet: p.newNet })),
		wireMods: [],
		pcb: { uuid: report.pcb?.uuid ?? cur?.uuid ?? '', tabId: report.pcb?.tabId ?? cur?.tabId, label: report.pcb?.label ?? 'PCB' },
	};
	await storeLedger(ledger); // 改动前落盘：中断可撤销

	// 先清空选中再写画布：修改"正处于选中状态"的焊盘会把交互层搞坏（见 hooks 注释）
	await pcbHooks.clearSelection();

	const outcome: ApplyPcbOutcome = { padsModified: 0, failedItems: [], ledger };
	for (let i = 0; i < ledger.padMods.length; i++) {
		const pm = ledger.padMods[i];
		let ok = false;
		for (let a = 0; a < attempts && !ok; a++) {
			ok = await pcbHooks.modifyPadNet(pm.padId, pm.newNet);
			if (!ok) {
				const wait = pacer.onFail();
				if (a < attempts - 1) {
					console.warn(`[headerswap] 焊盘 ${pm.padId} 未成功，${wait}ms 后重试`);
					await sleep(wait);
				}
			}
		}
		if (ok) {
			outcome.padsModified++;
			pacer.onSuccess();
		}
		else {
			outcome.failedItems.push(`${device}.${pm.padId}(${pm.oldNet}->${pm.newNet})`);
		}
		if (i < ledger.padMods.length - 1) {
			const wait = pacer.current();
			if (wait > 0)
				await sleep(wait);
		}
		onProgress?.(Math.round(((i + 1) / ledger.padMods.length) * 90), `改焊盘 ${i + 1}/${ledger.padMods.length}`);
	}
	await pcbHooks.savePcb();
	await pcbHooks.refreshPcbCanvas(ledger.pcb.uuid, ledger.pcb.tabId);
	onProgress?.(100, '完成');
	return outcome;
}

/* ------------------------- 同步原理图 ------------------------- */

export interface SyncSchOutcome {
	wires: number;
	/** 无法自动改写、需手工处理的引脚（含原因） */
	manual: string[];
	pageUuid: string;
}

/**
 * 把已应用的交换同步到原理图：定位器件所在图页，把参与交换引脚的独占导线
 * 网络改为新网络（两阶段改名规避交换环瞬时同名；失败退级删建）。
 * 非独占连接（汇入结点/电源符号承载）的引脚列入 manual 清单。
 */
export async function syncReportToSch(
	report: SwapReport,
	cfg: HeaderSwapConfig,
	schHooks: SchApplyHooks,
	onProgress?: (pct: number, msg: string) => void,
): Promise<SyncSchOutcome> {
	if (!report.chosenDevice || !report.appliedPcb)
		throw new Error('尚无已应用到 PCB 的交换（先执行「交换选中网络」并应用）');
	const plan = report.plans.find(p => p.headerDesignator === report.chosenDevice);
	if (!plan)
		throw new Error(`报告中没有器件 ${report.chosenDevice} 的方案`);

	onProgress?.(5, '定位器件所在原理图页…');
	const found = await findSchPageWithDevice(report.chosenDevice);
	const rawPins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(found.comp.getState_PrimitiveId())) ?? [];
	const header = {
		primitiveId: String(found.comp.getState_PrimitiveId?.() ?? ''),
		designator: report.chosenDevice,
		pins: rawPins.map((pin: any) => ({
			pinNumber: String(pin.getState_PinNumber?.() ?? '').trim(),
			pinName: String(pin.getState_PinName?.() ?? '').trim(),
			x: Number(pin.getState_X?.()),
			y: Number(pin.getState_Y?.()),
			noConnect: pin.getState_NoConnected?.() === true,
		})).filter((pin: any) => Number.isFinite(pin.x) && Number.isFinite(pin.y)),
	};

	onProgress?.(20, '读取图页导线与引脚…');
	const [wires, netflags, pagePins] = await Promise.all([
		readPageWires(),
		readPageNetFlags(),
		readPagePins(),
	]);
	const { classifyHeaderPins } = await import('./stub-model.ts');
	const classes = classifyHeaderPins(header, wires, netflags, pagePins);

	// 收集可自动改写的项与 manual 项
	const ledger = loadLedger();
	if (!ledger || !ledger.padMods.length)
		throw new Error('台账缺失（交换记录已被清理？请重新执行交换）');
	const attempts = Math.max(1, Math.round(cfg.maxRetries) + 1);
	const pacer = new AdaptivePacer(cfg.createIntervalMs);
	const outcome: SyncSchOutcome = { wires: 0, manual: [], pageUuid: found.pageUuid };
	const items: Array<{ wireIds: string[]; wireLines: Array<{ id: string; line: number[] }>; pin: string; net: string }> = [];

	for (const pin of plan.pins) {
		if (!pin.swappable || pin.newNet === pin.oldNet)
			continue;
		const cls = classes.get(pin.pinNumber);
		if (!cls?.stub)
			outcome.manual.push(`${report.chosenDevice}.${pin.pinNumber}（${pin.oldNet}->${pin.newNet}）：${cls?.reason === 'sch-shared' ? '连接已共享（汇入结点/总线）' : cls?.reason === 'sch-netflag' ? '网络由电源符号承载' : cls?.reason === 'net-mismatch' ? '簇内网络名冲突' : '未找到独占导线'}——请手动改`);
		else
			items.push({ wireIds: cls.stub.wireIds, wireLines: cls.stub.wireLines, pin: pin.pinNumber, net: pin.newNet });
	}

	// 两阶段改名：先临时名后最终名（导线同页网络名互斥/交换环瞬时同名）
	const tmpBase = '__HDRSWAP_TMP_';
	let seq = 0;
	let done = 0;
	const total = items.reduce((n, it) => n + it.wireIds.length, 0) || 1;
	const failedLines: string[] = [];
	for (const it of items) {
		for (const wid of it.wireIds) {
			const tmp = `${tmpBase}${seq++}`;
			await withRetry(() => schHooks.modifyWireNet(wid, tmp), attempts, pacer);
			done++;
			onProgress?.(20 + Math.round((done / total) * 30), `临时改名 ${done}/${total}`);
		}
	}
	done = 0;
	for (const it of items) {
		const planPin = plan.pins.find(p => p.pinNumber === it.pin);
		const oldNet = planPin ? planPin.oldNet : '';
		for (const w of it.wireLines) {
			const ok = await withRetry(() => schHooks.modifyWireNet(w.id, it.net), attempts, pacer);
			if (ok) {
				outcome.wires++;
				ledger.wireMods.push({ wireId: w.id, oldNet, newNet: it.net });
			}
			else {
				// 退级：删除原线 + 按原折线重建（带最终网络名）
				const del = await schHooks.deleteWires([w.id]);
				const newId = del ? await schHooks.createWire(w.line, it.net).catch(() => undefined) : undefined;
				if (newId) {
					outcome.wires++;
					ledger.wireMods.push({
						wireId: w.id,
						oldNet,
						newNet: it.net,
						recreated: { newWireId: newId, oldLine: w.line },
					});
				}
				else {
					failedLines.push(`${report.chosenDevice}.${it.pin}`);
				}
			}
			done++;
			onProgress?.(50 + Math.round((done / total) * 45), `写入网络 ${done}/${total}`);
			const wait = pacer.current();
			if (wait > 0)
				await sleep(wait);
		}
	}

	ledger.schPage = { uuid: found.pageUuid, tabId: found.tabId };
	await storeLedger(ledger);
	// 与 PCB 侧一致：写完自动保存（用户可 Ctrl+Z 前先看到确定的状态）
	try {
		await eda.sch_Document?.save?.();
	}
	catch { /* 保存失败不阻断（导线已在画布上） */ }
	for (const f of failedLines)
		outcome.manual.push(`${f}：改写失败（删建回退也未成功），请手动改`);
	onProgress?.(100, '完成');
	return outcome;
}

/** 简单重试包装（收操作工厂；失败间隔由 pacer 决定） */
async function withRetry(fn: () => Promise<boolean>, attempts: number, pacer: AdaptivePacer): Promise<boolean> {
	for (let a = 0; a < attempts; a++) {
		const r = await fn().catch(() => false);
		if (r) {
			pacer.onSuccess();
			return true;
		}
		const wait = pacer.onFail();
		if (a < attempts - 1)
			await sleep(wait);
	}
	return false;
}

/* ------------------------- 撤销 ------------------------- */

export interface UndoOutcome {
	pads: number;
	wires: number;
	failed: string[];
}

/**
 * 撤销上次交换（PCB 优先）：激活 PCB 恢复焊盘旧网络 -> 如已同步过原理图，
 * 激活对应图页恢复导线旧网络 -> 回到 PCB。台账用毕清理。
 */
export async function undoSwapLedger(
	ledger: SwapLedger,
	pcbHooks: PcbApplyHooks,
	schHooks: SchApplyHooks,
	onProgress?: (pct: number, msg: string) => void,
): Promise<UndoOutcome> {
	const failed: string[] = [];
	let pads = 0;
	let wires = 0;

	// 1. PCB 焊盘恢复（同样先清空选中，避免改"选中的焊盘"）
	if (ledger.padMods.length) {
		await activateDoc(ledger.pcb.uuid, ledger.pcb.tabId);
		await pcbHooks.clearSelection();
		for (let i = 0; i < ledger.padMods.length; i++) {
			const pm = ledger.padMods[i];
			if (await pcbHooks.modifyPadNet(pm.padId, pm.oldNet))
				pads++;
			else
				failed.push(`焊盘 ${pm.padId}`);
			onProgress?.(Math.round(((i + 1) / ledger.padMods.length) * 50), `恢复焊盘 ${i + 1}/${ledger.padMods.length}`);
			if (i < ledger.padMods.length - 1)
				await sleep(100);
		}
		await pcbHooks.savePcb();
		await pcbHooks.refreshPcbCanvas(ledger.pcb.uuid, ledger.pcb.tabId);
	}

	// 2. 原理图导线恢复（如同步过）
	if (ledger.wireMods.length && ledger.schPage) {
		await activateDoc(ledger.schPage.uuid, ledger.schPage.tabId);
		for (let i = 0; i < ledger.wireMods.length; i++) {
			const m = ledger.wireMods[i];
			if (m.recreated) {
				await schHooks.deleteWires([m.recreated.newWireId]);
				const back = await schHooks.createWire(m.recreated.oldLine, m.oldNet);
				if (back)
					wires++;
				else
					failed.push(`导线 ${m.wireId}`);
			}
			else {
				if (await schHooks.modifyWireNet(m.wireId, m.oldNet))
					wires++;
				else
					failed.push(`导线 ${m.wireId}`);
			}
			onProgress?.(50 + Math.round(((i + 1) / ledger.wireMods.length) * 45), `恢复导线 ${i + 1}/${ledger.wireMods.length}`);
			if (i < ledger.wireMods.length - 1)
				await sleep(100);
		}
	}

	// 2.5 原理图导线恢复后同样自动保存
	if (ledger.wireMods.length && ledger.schPage) {
		try {
			await eda.sch_Document?.save?.();
		}
		catch { /* ignore */ }
	}

	// 3. 回到 PCB（页签已被 refreshPcbCanvas 重开，旧 tabId 失效——只按 uuid 激活）
	if (ledger.padMods.length)
		await activateDoc(ledger.pcb.uuid);
	await clearLedger();
	onProgress?.(100, '完成');
	return { pads, wires, failed };
}
