import type { PageNetFlag, PagePinRef, PageWire } from '../src/stub-model.ts';
import type { Pad, SchHeader } from '../src/types.ts';

/* ---------------- 被测模块（纯逻辑直接导入） ---------------- */

import process from 'node:process';
import { countCrossings, evaluateRatsnest, mstEdges, netSegments } from '../src/metrics.ts';
import { CROSSING_WEIGHT_MIL, hungarian, solveHeaderSwap, virtualBoardPads } from '../src/solver.ts';
import {
	buildPinPlans,
	classifyHeaderPins,
	isBareVoltage,
	makePowerMatcher,

	parseLockPins,
} from '../src/stub-model.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import { installEdaMock, primMock } from './fixture.ts';
/**
 * 离线测试 / Offline tests（不依赖 EDA 运行时，node 直接运行）
 *
 * 覆盖：鼠线指标（MST/交叉）、匈牙利指派、排插求解器（含 2-opt 精修）、
 * 原理图连通簇分类与锁定规则、应用/撤销（含删建回退与 PCB 同步）、
 * 跨文档切换时序、端到端（mock EDA 全流程）。
 */

/* ---------------- 断言工具 ---------------- */

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: unknown, msg: string): void {
	if (cond) {
		pass++;
	}
	else {
		fail++;
		failures.push(msg);
		console.error(`FAIL: ${msg}`);
	}
}

function eq<T>(actual: T, expected: T, msg: string): void {
	ok(Object.is(actual, expected), `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`);
}

function near(actual: number, expected: number, tol: number, msg: string): void {
	ok(Math.abs(actual - expected) <= tol, `${msg}（期望 ≈${expected}，实际 ${actual}）`);
}

function section(name: string): void {
	console.log(`\n== ${name} ==`);
}

async function assertThrows(fn: () => Promise<unknown>, msg: string): Promise<void> {
	try {
		await fn();
		ok(false, `${msg}（未抛出异常）`);
	}
	catch {
		ok(true, msg);
	}
}

/* ================= A. 鼠线指标 ================= */

async function main(): Promise<void> {
	// 鼠线 settle 等待是纯 sleep（默认 2500ms 供实机大板），离线套件调小加速
	{
		const { setRatlineSettleMs } = await import('../src/eda-adapter.ts');
		setRatlineSettleMs(1);
	}

	section('A. 鼠线指标（MST / 交叉）');

	{
	// 矩形四角：MST = 三条边（1000 + 2000 + 1000）
		const r = netSegments([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 2000 }, { x: 0, y: 2000 }], 'N1');
		eq(r.segs.length, 3, 'A1 矩形 MST 边数');
		near(r.lengthMil, 4000, 1e-6, 'A2 矩形 MST 总长');
		eq(mstEdges([{ x: 0, y: 0 }]).length, 0, 'A3 单点无 MST 边');
	}
	{
	// X 交叉：两网络各一条边
		const segA = [{ net: 'A', ax: 0, ay: 0, bx: 1000, by: 1000 }];
		const segB = [{ net: 'B', ax: 0, ay: 1000, bx: 1000, by: 0 }];
		eq(countCrossings(segA, segB), 1, 'A4 不同网络规范相交计 1');
		const segC = [{ net: 'A', ax: 500, ay: 0, bx: 500, by: 1000 }];
		eq(countCrossings(segA, segC), 0, 'A5 端点相触不算交叉');
		eq(countCrossings(segA, segA), 0, 'A6 同网络不自计');
	}
	{
		const pads: Pad[] = [
			{ designator: 'U1', padNumber: '1', net: 'A', x: 0, y: 0 },
			{ designator: 'U2', padNumber: '1', net: 'A', x: 1000, y: 1000 },
			{ designator: 'U1', padNumber: '2', net: 'B', x: 0, y: 1000 },
			{ designator: 'U2', padNumber: '2', net: 'B', x: 1000, y: 0 },
		];
		const m = evaluateRatsnest(pads);
		eq(m.crossings, 1, 'A7 全板评估交叉数');
		near(m.totalLengthMil, 2 * Math.hypot(1000, 1000), 0.01, 'A8 全板评估总长');
		eq(evaluateRatsnest([{ designator: 'U1', padNumber: '1', net: '', x: 0, y: 0 }]).crossings, 0, 'A9 无网络焊盘忽略');
	}
	{
	// 超大网络采样截断：100 点 -> 64
		const pts = Array.from({ length: 100 }, (_, i) => ({ x: i * 10, y: 0 }));
		const r = netSegments(pts, 'BIG');
		ok(r.segs.length <= 63, `A10 采样后 MST 边数 ${r.segs.length} <= 63`);
	}

	/* ================= B. 匈牙利算法 ================= */

	section('B. 匈牙利指派');

	{
		const a = hungarian([[1, 9, 9], [9, 1, 9], [9, 9, 1]]);
		eq(a.join(','), '0,1,2', 'B1 对角最优=恒等');
		const b = hungarian([[9, 1, 9], [9, 9, 1], [1, 9, 9]]);
		eq(b.join(','), '1,2,0', 'B2 反对角最优=循环移位');
		eq(hungarian([[5]]).join(','), '0', 'B3 1x1');
	}
	{
	// 随机确定性矩阵：验证结果是排列且代价最优（与暴力枚举对比）
		const cost = [
			[4, 2, 7, 9],
			[3, 8, 5, 6],
			[7, 4, 2, 8],
			[2, 6, 9, 3],
		];
		const perm = hungarian(cost);
		eq(new Set(perm).size, 4, 'B4 结果是排列');
		const sum = (p: number[]) => p.reduce((s, c, r) => s + cost[r][c], 0);
		let brute = Number.POSITIVE_INFINITY;
		for (const p of [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1], [0, 3, 1, 2], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2], [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0], [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0], [2, 3, 0, 1], [2, 3, 1, 0], [3, 0, 1, 2], [3, 0, 2, 1], [3, 1, 0, 2], [3, 1, 2, 0], [3, 2, 0, 1], [3, 2, 1, 0]])
			brute = Math.min(brute, sum(p));
		eq(sum(perm), brute, 'B5 与暴力枚举同优');
	}
	ok(CROSSING_WEIGHT_MIL.crossings > CROSSING_WEIGHT_MIL.balanced && CROSSING_WEIGHT_MIL.balanced > CROSSING_WEIGHT_MIL.length, 'B6 权重档单调');

	/* ================= C. 排插求解器 ================= */

	section('C. 排插求解器（交叉最优化）');

	/** 镜像构造：J1 引脚 i (2000,100i) 现挂 IOi，U2 的 IOj 焊盘在 (3000,700-100j) */
	function mirrorBoard() {
		const boardPads: Pad[] = [];
		const slots: Array<{ pad: Pad; net: string }> = [];
		const nets: Array<{ net: string; others: Pad[] }> = [];
		for (let i = 1; i <= 6; i++) {
			const pad: Pad = { designator: 'J1', padNumber: String(i), net: `IO${i}`, x: 2000, y: 100 * i, padId: `pad-J1-${i}` };
			boardPads.push(pad);
			slots.push({ pad, net: `IO${i}` });
			boardPads.push({ designator: 'U2', padNumber: `PA${i}`, net: `IO${i}`, x: 3000, y: 700 - 100 * i, padId: `pad-U2-${i}` });
		}
		// GND：两锁定脚 + U2 侧（不参与交换）
		boardPads.push({ designator: 'J1', padNumber: '7', net: 'GND', x: 2000, y: 700, padId: 'pad-J1-7' });
		boardPads.push({ designator: 'J1', padNumber: '8', net: 'GND', x: 2000, y: 800, padId: 'pad-J1-8' });
		boardPads.push({ designator: 'U2', padNumber: 'GND', net: 'GND', x: 3000, y: 850, padId: 'pad-U2-G' });
		const slotIds = new Set(slots.map(s => s.pad.padId));
		for (const s of slots)
			nets.push({ net: s.net, others: boardPads.filter(b => b.net === s.net && !slotIds.has(b.padId)) });
		return { boardPads, slots, nets };
	}

	{
		const { boardPads, slots, nets } = mirrorBoard();
		const r = solveHeaderSwap(slots, nets, boardPads, 'J1', { weightMode: 'balanced', maxRefineIters: 4 });
		eq(r.metricsBefore.crossings, 15, 'C1 镜像排列交叉 = C(6,2)');
		eq(r.metricsAfter.crossings, 0, 'C2 最优排列交叉 = 0');
		ok(r.metricsAfter.totalLengthMil < r.metricsBefore.totalLengthMil, 'C3 总长下降');
		eq(r.changedCount, 6, 'C4 全部 6 脚交换');
		// 精确验证：脚 i 分到 IO(7-i)
		const expected = [5, 4, 3, 2, 1, 0];
		eq(r.assignment.join(','), expected.join(','), 'C5 精确反序指派');
	}
	{
	// 已最优：U2 焊盘顺序与 J1 一致 -> 无交换
		const boardPads: Pad[] = [];
		const slots: Array<{ pad: Pad; net: string }> = [];
		const nets: Array<{ net: string; others: Pad[] }> = [];
		for (let i = 1; i <= 4; i++) {
			const pad: Pad = { designator: 'J1', padNumber: String(i), net: `IO${i}`, x: 0, y: 100 * i, padId: `p${i}` };
			boardPads.push(pad);
			slots.push({ pad, net: `IO${i}` });
			boardPads.push({ designator: 'U2', padNumber: String(i), net: `IO${i}`, x: 1000, y: 100 * i, padId: `q${i}` });
		}
		const ids = new Set(slots.map(s => s.pad.padId));
		for (const s of slots)
			nets.push({ net: s.net, others: boardPads.filter(b => b.net === s.net && !ids.has(b.padId)) });
		const r = solveHeaderSwap(slots, nets, boardPads, 'J1', { weightMode: 'crossings', maxRefineIters: 4 });
		eq(r.changedCount, 0, 'C6 已最优时保持恒等');
		eq(r.metricsAfter.crossings, r.metricsBefore.crossings, 'C7 恒等时指标不变');
	}
	{
	// 悬空网络（无其它端点）代价 0：不干扰其余指派
		const { boardPads, slots, nets } = mirrorBoard();
		nets[5].others = []; // IO6 悬空
		const r = solveHeaderSwap(slots, nets, boardPads, 'J1', { weightMode: 'balanced', maxRefineIters: 4 });
		eq(new Set(r.assignment).size, 6, 'C8 含悬空网络仍为排列');
		ok(r.assignment[5] === 5 || r.metricsAfter.crossings <= r.metricsBefore.crossings, 'C9 悬空脚自由放置且不劣化');
	}
	{
	// 少于 2 个可换脚：直接恒等
		const r = solveHeaderSwap([{ pad: { designator: 'J1', padNumber: '1', net: 'A', x: 0, y: 0 }, net: 'A' }], [{ net: 'A', others: [] }], [{ designator: 'J1', padNumber: '1', net: 'A', x: 0, y: 0 }], 'J1', { weightMode: 'balanced', maxRefineIters: 4 });
		eq(r.changedCount, 0, 'C10 单脚恒等');
	}
	{
	// 虚拟焊盘表：只替换槽位焊盘网络
		const { boardPads, slots, nets } = mirrorBoard();
		const v = virtualBoardPads(boardPads, 'J1', slots, nets, [5, 4, 3, 2, 1, 0]);
		eq(v.find(p => p.padId === 'pad-J1-1')!.net, 'IO6', 'C11 虚拟表槽位改网');
		eq(v.find(p => p.padId === 'pad-U2-1')!.net, 'IO1', 'C12 虚拟表非槽位不动');
		eq(v.find(p => p.padId === 'pad-J1-7')!.net, 'GND', 'C13 锁定脚不动');
	}

	/* ================= D. 连通簇分类与锁定规则 ================= */

	section('D. 连通簇分类与锁定规则');

	/** 8 脚排插：引脚 i 在 (100, 100i)，各自一条水平 stub 导线 */
	function header8(): SchHeader {
		return {
			primitiveId: 'comp-J1',
			designator: 'J1',
			pins: Array.from({ length: 8 }, (_, i) => ({
				pinNumber: String(i + 1),
				pinName: `P${i + 1}`,
				x: 100,
				y: 100 * (i + 1),
				noConnect: false,
			})),
		};
	}

	function stubWires(netsByPin: Record<string, string>): PageWire[] {
		return Object.entries(netsByPin).map(([pin, net]) => {
			const y = 100 * Number(pin);
			return { id: `w${pin}`, line: [100, y, 150, y], vertices: [{ x: 100, y }, { x: 150, y }], ownNet: net, authNet: net ?? '' };
		});
	}

	{
		const h = header8();
		const wires = stubWires({ 1: 'IO1', 2: 'IO2', 3: 'IO3', 4: 'IO4' });
		const cls = classifyHeaderPins(h, wires, [], []);
		eq(cls.get('1')?.stub?.wireIds.join(','), 'w1', 'D1 独占簇识别载体');
		eq(cls.get('1')?.stub?.labelNets.join(','), 'IO1', 'D2 簇网络名');
		ok(!cls.get('1')?.reason, 'D3 独占簇无锁定原因');
		eq(cls.get('5')?.reason, 'sch-no-stub', 'D4 未连导线=sch-no-stub');
	}
	{
	// 共享：脚 2 的导线接到 U5 引脚
		const h = header8();
		const wires = stubWires({ 1: 'IO1', 2: 'IO2', 3: 'IO3' });
		wires[1].vertices = [{ x: 100, y: 200 }, { x: 300, y: 200 }];
		wires[1].line = [100, 200, 300, 200];
		const pagePins: PagePinRef[] = [
			{ designator: 'J1', pinNumber: '1', x: 100, y: 100 },
			{ designator: 'J1', pinNumber: '2', x: 100, y: 200 },
			{ designator: 'J1', pinNumber: '3', x: 100, y: 300 },
			{ designator: 'U5', pinNumber: '7', x: 300, y: 200 },
		];
		const cls = classifyHeaderPins(h, wires, [], pagePins);
		eq(cls.get('2')?.reason, 'sch-shared', 'D5 簇内含其它器件引脚=shared');
		eq(cls.get('1')?.reason, undefined, 'D6 其余脚不受影响');
	}
	{
	// netflag 承载 & 一簇两名
		const h = header8();
		const wires = stubWires({ 1: 'IO1' });
		wires[0].ownNet = '';
		wires[0].authNet = '';
		const flags: PageNetFlag[] = [{ id: 'f1', net: 'VCC', x: 150, y: 100 }];
		const cls = classifyHeaderPins(h, wires, flags, []);
		eq(cls.get('1')?.reason, 'sch-netflag', 'D7 电源符号承载=锁定');

		const wires2 = stubWires({ 2: 'A' });
		wires2[0].authNet = 'B';
		const cls2 = classifyHeaderPins(header8(), wires2, [], []);
		eq(cls2.get('2')?.reason, 'net-mismatch', 'D8 一簇两名=net-mismatch');
	}
	{
	// 电源名单与裸电压
		const isPow = makePowerMatcher(DEFAULT_CONFIG.powerPatterns);
		ok(isPow('GND') && isPow('gnd') && isPow('GND_1'), 'D9 GND 通配');
		ok(isPow('VDD') && isPow('VDDIO2') && isPow('VSSA'), 'D10 VDD/VSS 系');
		ok(isPow('+3V3') && isPow('3V3') && isPow('1V8') && isPow('12V'), 'D11 裸电压形态');
		ok(isPow('VIN') && isPow('VBAT') && isPow('VREF'), 'D12 VIN/VBAT/VREF 在名单');
		ok(!isPow('SDA') && !isPow('UART1_TX'), 'D13 信号名不误判');
		eq(isBareVoltage('3V3'), true, 'D14 3V3 裸电压');
		eq(isBareVoltage('V33'), false, 'D15 V33 非裸电压');
		const locks = parseLockPins('J1.1, J1.3, 5');
		ok(locks.exact.has('J1.1') && locks.exact.has('J1.3') && locks.bare.has('5'), 'D16 锁定名单解析');
		eq(parseLockPins('j1.2').exact.has('J1.2'), true, 'D17 位号大小写归一');
	}
	{
	// buildPinPlans 规则链
		const h = header8();
		// 脚 1..4 独占 stub（IO1..IO4）；脚 5=电源；脚 6 重复网络；脚 7 无网；脚 8 名字不一致
		const wires = [
			...stubWires({ 1: 'IO1', 2: 'IO2', 3: 'IO3', 4: 'IO4', 5: 'GND', 6: 'IO9', 7: '', 8: 'OTHER' }),
		];
		const pcbPads: Pad[] = [
			{ designator: 'J1', padNumber: '1', net: 'IO1', x: 0, y: 0, padId: 'pd1' },
			{ designator: 'J1', padNumber: '2', net: 'IO2', x: 0, y: 100, padId: 'pd2' },
			{ designator: 'J1', padNumber: '3', net: 'IO3', x: 0, y: 200, padId: 'pd3' },
			{ designator: 'J1', padNumber: '4', net: 'IO4', x: 0, y: 300, padId: 'pd4' },
			{ designator: 'J1', padNumber: '5', net: 'GND', x: 0, y: 400, padId: 'pd5' },
			{ designator: 'J1', padNumber: '6', net: 'IO9', x: 0, y: 500, padId: 'pd6' },
			{ designator: 'J1', padNumber: '7', net: '', x: 0, y: 600, padId: 'pd7' },
			{ designator: 'J1', padNumber: '8', net: 'IO8', x: 0, y: 700, padId: 'pd8' },
			{ designator: 'J1', padNumber: '6', net: 'IO9', x: 0, y: 501, padId: 'pd6b' }, // 同脚多焊盘（异常但容忍）
		];
		// 用两个引脚承载 IO9 制造 duplicate-net：把脚 8 也接到 IO9 —— 改用脚 8 wire=IO9
		wires[7].ownNet = 'IO9';
		wires[7].authNet = 'IO9';
		pcbPads[7] = { designator: 'J1', padNumber: '8', net: 'IO9', x: 0, y: 700, padId: 'pd8' };
		const pagePins: PagePinRef[] = h.pins.map(p => ({ designator: 'J1', pinNumber: p.pinNumber, x: p.x, y: p.y }));
		const plans = buildPinPlans(h, pcbPads, wires, [], pagePins, DEFAULT_CONFIG);
		const by = (n: string) => plans.find(p => p.pinNumber === n)!;
		eq(by('1').swappable, true, 'D18 独占 stub 可换');
		eq(by('1').stub?.wireIds[0], 'w1', 'D19 计划带载体');
		eq(by('5').lockReason, 'power', 'D20 电源锁定');
		eq(by('6').lockReason, 'duplicate-net', 'D21 重复网络锁定');
		eq(by('7').lockReason, 'no-net', 'D22 无网络锁定');
		eq(plans.find(p => p.pinNumber === '9'), undefined, 'D23 原理图 8 脚全收录');
	}
	{
	// 用户锁定与名字不一致
		const h = header8();
		const wires = stubWires({ 1: 'IO1', 2: 'IO2' });
		const pcbPads: Pad[] = [
			{ designator: 'J1', padNumber: '1', net: 'IO1', x: 0, y: 0 },
			{ designator: 'J1', padNumber: '2', net: 'IOX', x: 0, y: 100 },
		];
		const pagePins: PagePinRef[] = h.pins.map(p => ({ designator: 'J1', pinNumber: p.pinNumber, x: p.x, y: p.y }));
		const cfg = { ...DEFAULT_CONFIG, lockPins: 'J1.1' };
		const plans = buildPinPlans(h, pcbPads, wires, [], pagePins, cfg);
		eq(plans.find(p => p.pinNumber === '1')!.lockReason, 'locked-user', 'D24 用户锁定优先于可换');
		eq(plans.find(p => p.pinNumber === '2')!.lockReason, 'net-mismatch', 'D25 原理图/PCB 名不一致锁定');
		// 纯引脚号锁定（作用于任意排插）
		const cfg2 = { ...DEFAULT_CONFIG, lockPins: '2' };
		const plans2 = buildPinPlans(h, pcbPads, wires, [], pagePins, cfg2);
		eq(plans2.find(p => p.pinNumber === '2')!.lockReason, 'locked-user', 'D26 纯引脚号锁定');
		// 无对应焊盘
		const plans3 = buildPinPlans(header8(), [], [], [], [], DEFAULT_CONFIG);
		eq(plans3.find(p => p.pinNumber === '3')!.lockReason, 'no-pcb-pad', 'D27 无焊盘锁定');
	}

	/* ================= E. 应用 / 同步 / 撤销（hooks 级） ================= */

	section('E. 应用与撤销');

	function mockSchHooks(failIds: string[] = []) {
		const nets = new Map<string, string>([['uw1', 'IO1'], ['uw2', 'IO2'], ['uw3', 'IO3'], ['uw4', 'IO4']]);
		const rec = { modify: [] as Array<{ id: string; net: string }>, create: [] as Array<{ line: number[]; net: string }>, deleted: [] as string[] };
		return {
			nets,
			rec,
			hooks: {
				readWireNet: async (id: string) => nets.get(id),
				modifyWireNet: async (id: string, net: string) => {
					if (failIds.includes(id))
						return false;
					nets.set(id, net);
					rec.modify.push({ id, net });
					return true;
				},
				deleteWires: async (ids: string[]) => {
					for (const id of ids)
						nets.delete(id);
					rec.deleted.push(...ids);
					return true;
				},
				createWire: async (line: number[], net: string) => {
					const id = `nw${rec.create.length + 1}`;
					nets.set(id, net);
					rec.create.push({ line, net });
					return id;
				},
			},
		};
	}

	function mockPcbHooks() {
		const rec = { modify: [] as Array<{ padId: string; net: string }>, save: 0, refresh: 0, cleared: 0 };
		return {
			rec,
			hooks: {
				clearSelection: async () => {
					rec.cleared++;
				},
				modifyPadNet: async (padId: string, net: string) => {
					rec.modify.push({ padId, net });
					return true;
				},
				savePcb: async () => {
					rec.save++;
					return true;
				},
				refreshPcbCanvas: async () => {
					rec.refresh++;
				},
			},
		};
	}

	/** 新流程报告：U2 器件、4 脚交换 IO1<->IO4, IO2<->IO3（镜像构造成例） */
	function deviceReport(): import('../src/types.ts').SwapReport {
		const pin = (n: string, oldNet: string, newNet: string): import('../src/types.ts').HeaderPinPlan => ({
			pinNumber: n,
			pinName: n,
			oldNet,
			newNet,
			swappable: true,
			pad: { designator: 'U2', padNumber: n, net: oldNet, x: 0, y: 0, padId: `pad-U2-${n}` },
		});
		return {
			generatedAt: '2026-09-18T00:00:00.000Z',
			selectedNets: ['IO1', 'IO2', 'IO3', 'IO4'],
			plans: [{
				headerDesignator: 'U2',
				pins: [pin('PA1', 'IO1', 'IO4'), pin('PA2', 'IO2', 'IO3'), pin('PA3', 'IO3', 'IO2'), pin('PA4', 'IO4', 'IO1')],
				metricsBefore: { totalLengthMil: 4000, crossings: 6 },
				metricsAfter: { totalLengthMil: 2000, crossings: 0 },
				changedCount: 4,
				swappableCount: 4,
			}],
			routedLengthMil: {},
			notes: [],
		};
	}

	/** 同步原理图用的 sch 夹具：U2 四个引脚各带独占 stub 导线 */
	function syncSchFixture(failIds: string[] = []) {
		const u2pins = [1, 2, 3, 4].map(j => ({ id: `up${j}`, pinNumber: `PA${j}`, pinName: `PA${j}`, x: 900, y: 100 * j }));
		const wires = [1, 2, 3, 4].map(j => ({ id: `uw${j}`, line: [900, 100 * j, 850, 100 * j], net: `IO${j}` }));
		return installEdaMock({
			comps: [{ id: 'comp-U2', designator: 'U2', pins: u2pins }],
			wires,
			projectNets: [1, 2, 3, 4].map(j => ({ net: `IO${j}`, wires: [`uw${j}`] })),
			failWireIds: failIds,
		});
	}

	{
		// 应用到 PCB：台账先行、焊盘逐个改、保存+刷新鼠线
		installEdaMock({});
		const { applyDeviceToPcb, loadLedger } = await import('../src/eda-adapter.ts');
		const p = mockPcbHooks();
		const out = await applyDeviceToPcb(deviceReport(), 'U2', DEFAULT_CONFIG, p.hooks);
		eq(out.padsModified, 4, 'E1 4 焊盘改写');
		eq(out.failedItems.length, 0, 'E2 无失败');
		ok(p.rec.modify.some(x => x.padId === 'pad-U2-PA1' && x.net === 'IO4'), 'E3 PA1 -> IO4');
		eq(p.rec.save, 1, 'E4 PCB 保存一次');
		eq(p.rec.refresh, 1, 'E5 鼠线刷新一次');
		eq(p.rec.cleared, 1, 'E5b 写画布前清空选中');
		const ledger = loadLedger()!;
		eq(ledger.device, 'U2', 'E6 台账记器件');
		eq(ledger.padMods.find(m => m.padId === 'pad-U2-PA1')?.oldNet, 'IO1', 'E7 台账记旧网络');
		ok(ledger.pcb.uuid.length > 0, 'E8 台账记 PCB 上下文');
	}
	{
		// 撤销（PCB 优先）：恢复焊盘旧网络
		installEdaMock({});
		const { applyDeviceToPcb, loadLedger, undoSwapLedger } = await import('../src/eda-adapter.ts');
		await applyDeviceToPcb(deviceReport(), 'U2', DEFAULT_CONFIG, mockPcbHooks().hooks);
		const p2 = mockPcbHooks();
		const r = await undoSwapLedger(loadLedger()!, p2.hooks, mockSchHooks().hooks);
		eq(r.pads, 4, 'E9 撤销恢复 4 焊盘');
		ok(p2.rec.modify.some(x => x.padId === 'pad-U2-PA1' && x.net === 'IO1'), 'E10 PA1 回 IO1');
		eq(r.failed.length, 0, 'E11 无失败');
	}
	{
		// 同步原理图：器件页定位 -> 独占 stub 两阶段改名 -> 台账扩展
		syncSchFixture();
		const { applyDeviceToPcb, syncReportToSch, loadLedger } = await import('../src/eda-adapter.ts');
		await applyDeviceToPcb(deviceReport(), 'U2', DEFAULT_CONFIG, mockPcbHooks().hooks);
		const report = deviceReport();
		report.chosenDevice = 'U2';
		report.appliedPcb = true;
		const m = mockSchHooks();
		const out = await syncReportToSch(report, DEFAULT_CONFIG, m.hooks);
		eq(out.wires, 4, 'E12 同步改写 4 条导线');
		eq(out.manual.length, 0, 'E13 无手工项');
		eq(m.nets.get('uw1'), 'IO4', 'E14 uw1 -> IO4');
		ok(m.rec.modify.slice(0, 4).every(x => x.net.startsWith('__HDRSWAP_TMP_')), 'E15 先临时名');
		const ledger = loadLedger()!;
		eq(ledger.wireMods.length, 4, 'E16 台账扩展导线记录');
		eq(ledger.wireMods.find(w => w.wireId === 'uw1')?.oldNet, 'IO1', 'E17 台账记旧网络');
		ok(ledger.schPage?.uuid, 'E18 台账记原理图页');
	}
	{
		// 删建回退：uw2 的 modify 一律失败 -> 删原线按折线重建；撤销含删建线恢复
		syncSchFixture(['uw2']);
		const { applyDeviceToPcb, syncReportToSch, loadLedger, undoSwapLedger } = await import('../src/eda-adapter.ts');
		await applyDeviceToPcb(deviceReport(), 'U2', DEFAULT_CONFIG, mockPcbHooks().hooks);
		const report = deviceReport();
		report.chosenDevice = 'U2';
		report.appliedPcb = true;
		const m = mockSchHooks(['uw2']);
		const out = await syncReportToSch(report, DEFAULT_CONFIG, m.hooks);
		eq(out.wires, 4, 'E19 删建回退也计入成功');
		ok(m.rec.deleted.includes('uw2'), 'E20 uw2 已删除');
		ok(m.rec.create.some(c => c.net === 'IO3' && c.line.join(',') === '900,200,850,200'), 'E21 按原折线重建');
		const ledger = loadLedger()!;
		const m2 = ledger.wireMods.find(w => w.wireId === 'uw2')!;
		ok(m2.recreated?.newWireId, 'E22 台账记删建信息');
		const undoHooks = mockSchHooks();
		const r = await undoSwapLedger(ledger, mockPcbHooks().hooks, undoHooks.hooks);
		eq(r.wires, 4, 'E23 撤销恢复含删建线');
		ok(undoHooks.rec.deleted.includes(m2.recreated!.newWireId), 'E24 撤销删除重建线');
		ok(undoHooks.rec.create.some(c => c.net === 'IO2'), 'E25 撤销按旧网络重建');
	}
	{
		// 共享连接 -> 手工清单
		const u2pins = [1, 2].map(j => ({ id: `up${j}`, pinNumber: `PA${j}`, pinName: `PA${j}`, x: 900, y: 100 * j }));
		const wires = [
			{ id: 'uw1', line: [900, 100, 850, 100], net: 'IO1' },
			{ id: 'uw2', line: [900, 200, 600, 200, 600, 300], net: 'IO2' }, // 汇入点 (600,300)
		];
		installEdaMock({
			comps: [{ id: 'comp-U2', designator: 'U2', pins: u2pins }, { id: 'comp-U5', designator: 'U5', pins: [{ id: 'u5p1', pinNumber: '7', pinName: '7', x: 600, y: 300 }] }],
			wires,
			projectNets: [{ net: 'IO1', wires: ['uw1'] }, { net: 'IO2', wires: ['uw2'] }],
		});
		const { applyDeviceToPcb, syncReportToSch } = await import('../src/eda-adapter.ts');
		await applyDeviceToPcb(deviceReport(), 'U2', DEFAULT_CONFIG, mockPcbHooks().hooks);
		const report = deviceReport();
		report.chosenDevice = 'U2';
		report.appliedPcb = true;
		// 器件页只有 PA1/PA2，其余引脚不存在；PA2 汇入共享点
		const out = await syncReportToSch(report, DEFAULT_CONFIG, mockSchHooks().hooks);
		ok(out.manual.some(x => x.includes('PA3') || x.includes('PA4')), 'E26 器件页无对应引脚列手工项');
		ok(out.manual.some(x => x.includes('PA2') && x.includes('共享')), 'E27 共享连接列手工项');
	}

	{
		// 生产 hooks 的 setState 主路径：活引脚对象 setState_Net + done 真实改网
		const { resetPinObjCache } = await import('../src/eda-adapter.ts');
		resetPinObjCache();
		installEdaMock({
			pcbComps: [{ id: 'pc-U1', designator: 'U1' }],
			pcbPads: [
				{ designator: 'U1', padNumber: '1', net: 'A', x: 0, y: 0, padId: 'pd-1' },
				{ designator: 'U1', padNumber: '2', net: 'B', x: 0, y: 100, padId: 'pd-2' },
			],
			livePins: true,
		});
		const { createPcbHooks, collectBoardState } = await import('../src/eda-adapter.ts');
		const hooks = createPcbHooks();
		const ok1 = await hooks.modifyPadNet('pd-1', 'A2');
		eq(ok1, true, 'E28 setState 主路径改网成功');
		const st = await collectBoardState();
		eq(st.pads.find(p => p.padId === 'pd-1')?.net, 'A2', 'E29 焊盘网络真实变化（pad 读取可见）');
	}

	{
		// 兜底路径：无活引脚（普通 primMock 引脚）时退到类级 modify
		const { resetPinObjCache } = await import('../src/eda-adapter.ts');
		resetPinObjCache();
		const mk = installEdaMock({
			pcbComps: [{ id: 'pc-U1', designator: 'U1' }],
			pcbPads: [{ designator: 'U1', padNumber: '1', net: 'A', x: 0, y: 0, padId: 'pd-1' }],
		});
		const { createPcbHooks } = await import('../src/eda-adapter.ts');
		const ok2 = await createPcbHooks().modifyPadNet('pd-1', 'A3');
		eq(ok2, true, 'E30 兜底路径（类级 modify）可用');
		ok(mk.calls.padModify.some(x => x.padId === 'pd-1' && x.net === 'A3'), 'E31 兜底经类级 modify 记录');
		resetPinObjCache();
	}

	/* ================= F. 板状态与器件页定位 ================= */

	section('F. 板状态与器件页定位');

	{
		installEdaMock({
			pcbComps: [{ id: 'pc-J1', designator: 'J1' }, { id: 'pc-U2', designator: 'U2' }],
			pcbPads: [
				{ designator: 'J1', padNumber: '1', net: 'A', x: 100, y: 200 },
				{ designator: 'U2', padNumber: '3', net: 'A', x: 900, y: 800 },
			],
			pcbLines: [{ net: 'A', x1: 100, y1: 200, x2: 900, y2: 800 }],
		});
		const { collectBoardState } = await import('../src/eda-adapter.ts');
		const st = await collectBoardState();
		eq(st.pads.length, 2, 'F1 焊盘数');
		const j1 = st.pads.find(p => p.designator === 'J1')!;
		eq(j1.padNumber, '1', 'F2 焊盘号');
		ok(j1.padId && j1.padId.length > 0, 'F3 焊盘带图元 ID');
		near(st.routedLengthMil.A ?? 0, Math.hypot(800, 600), 1e-6, 'F4 走线长度归网');
		eq(st.pcb.uuid, 'pcb-uuid-1', 'F5 PCB 上下文取当前活动文档');
	}
	{
		// 多 PCB + 当前文档不匹配：取名称序首并提示
		installEdaMock({
			projectInfo: { data: [
				{ type: 'board', name: 'B2', pcb: { uuid: 'pcb-2' } },
				{ type: 'board', name: 'B1', pcb: { uuid: 'pcb-1' } },
			] },
			pcbPads: [{ designator: 'J1', padNumber: '1', net: 'A', x: 0, y: 0 }],
		});
		const { collectBoardState } = await import('../src/eda-adapter.ts');
		const st = await collectBoardState();
		eq(st.pcb.uuid, 'pcb-1', 'F6 多 PCB 取名称序首');
		ok(st.notes.some(n => n.includes('2 个 PCB')), 'F7 多 PCB 提示');
		ok(st.notes.some(n => n.includes('不是所选 PCB')), 'F8 当前文档不匹配提示');
	}
	{
		installEdaMock({ projectInfo: { data: [] } });
		const { collectBoardState } = await import('../src/eda-adapter.ts');
		await assertThrows(() => collectBoardState(), 'F9 无 PCB 抛错');
	}
	{
		installEdaMock({ pcbPads: [] });
		const { collectBoardState } = await import('../src/eda-adapter.ts');
		await assertThrows(() => collectBoardState(), 'F10 空焊盘抛错');
	}
	{
		// 器件页定位：多页时逐页找到含 U2 的页
		const u2 = { id: 'comp-U2', designator: 'U2', pins: [{ id: 'up1', pinNumber: 'PA1', pinName: 'PA1', x: 0, y: 0 }] };
		const j1 = { id: 'comp-J1', designator: 'J1', pins: [{ id: 'jp1', pinNumber: '1', pinName: '1', x: 0, y: 0 }] };
		const mk = installEdaMock({
			comps: [j1, u2],
			projectInfo: { data: [
				{ type: 'board', name: 'B', schematic: { uuid: 'sch-root', pages: [{ uuid: 'page-1' }, { uuid: 'page-2' }] }, pcb: { uuid: 'pcb-uuid-1' } },
			] },
			currentDoc: { uuid: 'pcb-uuid-1' },
		});
		// 模拟分页：page-1 只有 J1，page-2 有 U2
		const pages: Record<string, any[]> = { 'page-1': [j1], 'page-2': [u2] };
		let activePage = 'page-1';
		(globalThis as any).eda.sch_PrimitiveComponent.getAll = async (type?: string) => {
			if (type === 'netflag')
				return [];
			return pages[activePage].map(c => primMock({ PrimitiveId: c.id, Designator: c.designator, ComponentType: 'part' }, { getState_PrimitiveType: () => 'Component' }));
		};
		const origOpen = (globalThis as any).eda.dmt_EditorControl.openDocument;
		(globalThis as any).eda.dmt_EditorControl.openDocument = async (uuid: string) => {
			if (uuid.startsWith('page-'))
				activePage = uuid;
			return origOpen(uuid);
		};
		const { findSchPageWithDevice } = await import('../src/eda-adapter.ts');
		const found = await findSchPageWithDevice('U2');
		eq(found.pageUuid, 'page-2', 'F11 逐页定位到 U2 所在页');
		ok(mk.calls.editor.includes('open:page-1'), 'F12 先搜第一页');
		await assertThrows(() => findSchPageWithDevice('U9'), 'F13 找不到器件抛错');
	}
	{
		// V3.2 实机形态：pad 图元无 parent 方法 -> 器件引脚反查映射
		installEdaMock({
			pcbComps: [{ id: 'pc-J1', designator: 'J1' }, { id: 'pc-U2', designator: 'U2' }],
			pcbPads: [
				{ designator: 'J1', padNumber: '1', net: 'A', x: 100, y: 200, padId: 'pd-1' },
				{ designator: 'U2', padNumber: '3', net: 'A', x: 900, y: 800, padId: 'pd-2' },
			],
			padsLackParent: true,
		});
		const { collectBoardState } = await import('../src/eda-adapter.ts');
		const st = await collectBoardState();
		eq(st.pads.find(p => p.padId === 'pd-1')?.designator, 'J1', 'F14 无 parent 方法时位号经器件引脚映射');
		eq(st.pads.find(p => p.padId === 'pd-2')?.designator, 'U2', 'F15 两个器件都映射成功');
		ok(st.notes.some(n => n.includes('器件引脚映射')), 'F16 映射路径记入提示');
	}
	{
		// 选中网络读取
		installEdaMock({ selectedPcbNets: ['IO2', 'IO1', 'IO2', ''] });
		const { readSelectedPcbNets } = await import('../src/eda-adapter.ts');
		const nets = await readSelectedPcbNets();
		eq(nets.join(','), 'IO1,IO2', 'F17 选中网络去重排序');
	}
	{
		// V3.2 实机形态（2026-09-22 桥上取证）：无参 getAll() 必抛「获取所有器件失败」，
		// 只有 getAll('part', true) 可用——器件页定位在单页工程应照常命中
		const u4 = { id: 'comp-U4', designator: 'U4', pins: [{ id: 'u4p1', pinNumber: '41', pinName: 'IO41', x: 500, y: 300 }] };
		const mk = installEdaMock({
			comps: [u4],
			schGetAllArglessFails: true,
			projectInfo: { data: [{ type: 'board', schematic: { uuid: 'sch-only', page: { uuid: 'sch-page-1' } }, pcb: { uuid: 'pcb-uuid-1' } }] },
			currentDoc: { uuid: 'pcb-uuid-1' },
		});
		const { findSchPageWithDevice } = await import('../src/eda-adapter.ts');
		const found = await findSchPageWithDevice('U4');
		eq(found.pageUuid, 'sch-only', 'F18 无参 getAll 失败时经 (part,true) 定位器件页');
		ok(mk.calls.schGetAll.includes('part:true'), 'F19 使用了 getAll(part,true) 形态');
		ok(!mk.calls.schGetAll.includes('(none):false'), 'F20 未再调用无参 getAll');
	}
	{
		// 多页 + 跨页 getAll：几何确认器件所在页（引脚落在该页导线上）
		const u2 = { id: 'comp-U2', designator: 'U2', pins: [{ id: 'up1', pinNumber: 'PA1', pinName: 'PA1', x: 900, y: 600 }] };
		const j1 = { id: 'comp-J1', designator: 'J1', pins: [{ id: 'jp1', pinNumber: '1', pinName: '1', x: 100, y: 100 }] };
		installEdaMock({
			comps: [j1, u2],
			wires: [{ id: 'uw1', line: [900, 600, 700, 600], net: 'IO1' }],
			projectInfo: { data: [{ type: 'board', schematic: { uuid: 'sch-root', pages: [{ uuid: 'page-1' }, { uuid: 'page-2' }] }, pcb: { uuid: 'pcb-uuid-1' } }] },
			currentDoc: { uuid: 'pcb-uuid-1' },
		});
		const pages: Record<string, any[]> = { 'page-1': [j1], 'page-2': [j1, u2] };
		let activePage = 'page-1';
		(globalThis as any).eda.sch_PrimitiveComponent.getAll = async (type?: string, allPages?: boolean) => {
			if (type === 'netflag')
				return [];
			if (type === 'part' && allPages === true)
				return pages[activePage].map(c => primMock({ PrimitiveId: c.id, Designator: c.designator, ComponentType: 'part' }, { getState_PrimitiveType: () => 'Component' }));
			throw new Error('获取所有器件失败');
		};
		const origOpen2 = (globalThis as any).eda.dmt_EditorControl.openDocument;
		(globalThis as any).eda.dmt_EditorControl.openDocument = async (uuid: string) => {
			if (uuid.startsWith('page-'))
				activePage = uuid;
			return origOpen2(uuid);
		};
		const { findSchPageWithDevice } = await import('../src/eda-adapter.ts');
		const found = await findSchPageWithDevice('U2');
		eq(found.pageUuid, 'page-2', 'F21 跨页 getAll 下按导线几何确认所在页');
	}

	/* ================= G. 端到端（mock EDA 全流程） ================= */

	section('G. 端到端');

	/**
	 * 镜像工程（PCB 主场视角）：
	 * - J1 焊盘 1..6 (2000,100i) 挂 IO1..IO6；U2 焊盘 Paj (3000,700-100j) 挂 IOj —— 互为镜像
	 * - 原理图页：U2 引脚 Paj (900,700-100j) 各带独占导线 uwj 挂 IOj；J1 引脚不接线（对 U2 侧交换无影响）
	 * - IO3 有走线（守卫数据）
	 */
	function mirrorFixture() {
		const j1Pins = Array.from({ length: 8 }, (_, i) => ({
			id: `sp${i + 1}`,
			pinNumber: String(i + 1),
			pinName: `P${i + 1}`,
			x: 100,
			y: 100 * (i + 1),
		}));
		const u2Pins = Array.from({ length: 6 }, (_, i) => ({
			id: `up${i + 1}`,
			pinNumber: `PA${i + 1}`,
			pinName: `PA${i + 1}`,
			x: 900,
			y: 700 - 100 * (i + 1),
		}));
		const wires = [];
		const projectNets = [];
		for (let j = 1; j <= 6; j++) {
			const y = 700 - 100 * j;
			wires.push({ id: `uw${j}`, line: [900, y, 850, y], net: `IO${j}` });
			projectNets.push({ net: `IO${j}`, wires: [`uw${j}`] });
		}
		const pcbPads = [];
		for (let i = 1; i <= 8; i++)
			pcbPads.push({ designator: 'J1', padNumber: String(i), net: i <= 6 ? `IO${i}` : 'GND', x: 2000, y: 100 * i, padId: `pad-J1-${i}` });
		for (let j = 1; j <= 6; j++)
			pcbPads.push({ designator: 'U2', padNumber: `PA${j}`, net: `IO${j}`, x: 3000, y: 700 - 100 * j, padId: `pad-U2-${j}` });
		pcbPads.push({ designator: 'U2', padNumber: 'GND', net: 'GND', x: 3000, y: 850, padId: 'pad-U2-G' });

		return {
			selectedPcbNets: ['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6'],
			comps: [
				{ id: 'comp-J1', designator: 'J1', pins: j1Pins },
				{ id: 'comp-U2', designator: 'U2', pins: u2Pins },
			],
			wires,
			netFlags: [],
			projectNets,
			pcbComps: [{ id: 'pc-J1', designator: 'J1' }, { id: 'pc-U2', designator: 'U2' }],
			pcbPads,
			pcbLines: [{ net: 'IO3', x1: 0, y1: 0, x2: 500, y2: 0 }],
			currentDoc: { uuid: 'pcb-uuid-1', tabId: 'tab-pcb-uuid-1' },
			livePins: true, // 生产 createPcbHooks 的 setState_Net 主路径端到端
		};
	}

	{
		const mk = installEdaMock(mirrorFixture());
		mk.storage.set('schHeaderSwapConfig', JSON.stringify({ ...DEFAULT_CONFIG, createIntervalMs: 0 }));
		const index = await import('../src/index.ts');
		await index.runNetSwap();
		ok(mk.calls.iframes.some(f => f.html === '/iframe/preview.html'), 'G1 打开预览窗');
		ok(mk.calls.busChannels.includes('header-swap-cmd'), 'G2 注册命令通道');
		const report = JSON.parse(mk.storage.get('schHeaderSwapLastPlan')!);
		eq(report.selectedNets.join(','), 'IO1,IO2,IO3,IO4,IO5,IO6', 'G3 选中网络入报告');
		const devices = report.plans.map((p: any) => p.headerDesignator);
		eq(devices.join(','), 'J1,U2', 'G4 候选器件按位号排序');
		const u2 = report.plans.find((p: any) => p.headerDesignator === 'U2');
		eq(u2.metricsBefore.crossings, 15, 'G5 U2 镜像排列 15 交叉');
		eq(u2.metricsAfter.crossings, 0, 'G6 最优 0 交叉');
		eq(u2.changedCount, 6, 'G7 6 脚交换');
		const pa1 = u2.pins.find((p: any) => p.pinNumber === 'PA1');
		eq(pa1.newNet, 'IO6', 'G8 PA1 -> IO6');

		// 应用（MessageBus 模拟预览窗按钮选 U2）；refreshPcbCanvas 关开页签后完成
		mk.pushBus('header-swap-cmd', JSON.stringify({ cmd: 'apply', device: 'U2' }));
		for (let w = 0; w < 60 && !JSON.parse(mk.storage.get('schHeaderSwapLastPlan') ?? '{}').appliedPcb; w++)
			await new Promise(r => setTimeout(r, 50));
		eq(mk.calls.padModify.length, 6, 'G9 U2 六焊盘改写');
		ok(mk.calls.padModify.some(p => p.padId === 'pad-U2-1' && p.net === 'IO6'), 'G10 pad-U2-1 -> IO6');
		ok(!mk.calls.padModify.some(p => p.padId.startsWith('pad-J1')), 'G11 J1 焊盘不动');
		eq(mk.calls.pcbSave, 1, 'G12 PCB 保存');
		ok(mk.calls.editor.some(c => c.startsWith('close:')), 'G13 写后关开 PCB 页签（画布重建）');
		ok(mk.calls.confirms.some(c => c.includes('已有走线')), 'G14 走线警告确认（IO3）');
		const applied = JSON.parse(mk.storage.get('schHeaderSwapLastPlan')!);
		eq(applied.appliedPcb, true, 'G15 报告标记已应用');
		eq(applied.chosenDevice, 'U2', 'G16 报告记所选器件');
		ok(mk.storage.has('schHeaderSwapLedger'), 'G17 台账落盘');

		// 同步原理图：U2 页 stub 导线改为新网络
		await index.syncLastSwapToSch();
		for (let j = 1; j <= 6; j++)
			eq(mk.wireNet(`uw${j}`), `IO${7 - j}`, `G18 uw${j} -> IO${7 - j}`);
		ok(mk.calls.schSave >= 1, 'G18b 同步后自动保存原理图');
		ok(mk.calls.editor.some(c => c === 'open:sch-uuid-1' || c === 'open:sch-page-1'), 'G19 定位并打开 U2 所在图页');
		const synced = JSON.parse(mk.storage.get('schHeaderSwapLastPlan')!);
		eq(synced.schSynced, true, 'G20 报告标记已同步');

		// 撤销：PCB 焊盘 + 原理图导线一并恢复
		await index.undoLastSwap();
		eq(mk.calls.padModify.length, 12, 'G21 焊盘改写共 12 次（应用 6 + 撤销 6）');
		ok(mk.calls.padModify.some(p => p.padId === 'pad-U2-1' && p.net === 'IO1'), 'G22 pad-U2-1 回 IO1');
		for (let j = 1; j <= 6; j++)
			eq(mk.wireNet(`uw${j}`), `IO${j}`, `G23 uw${j} 恢复 IO${j}`);
		eq(mk.storage.get('schHeaderSwapLedger'), '', 'G24 撤销后台账清理');
		ok(mk.calls.selectionCleared >= 2, 'G30 应用与撤销写画布前均清空选中（防交互层锁死）');
		ok(mk.calls.toastTypes.length > 0 && mk.calls.toastTypes.every(t => t === 2 || t === 3), 'G29 toast 类型为 V3.2 数字枚举（2=信息/3=成功，绝无 0=错误图标）');
		const undone = JSON.parse(mk.storage.get('schHeaderSwapLastPlan')!);
		eq(undone.appliedPcb, false, 'G25 报告复位可重应用');
	}

	{
		// 错误路径：单网络引导 / 未应用先同步 / 无台账撤销
		const mk = installEdaMock({ ...mirrorFixture(), selectedPcbNets: ['IO1'] });
		const index = await import('../src/index.ts');
		await index.runNetSwap();
		ok(mk.calls.dialogs.some(d => d.content.includes('选中网络不足 2 个')), 'G26 单网络引导');

		const mk2 = installEdaMock({});
		const index2 = await import('../src/index.ts');
		await index2.syncLastSwapToSch();
		ok(mk2.calls.dialogs.some(d => d.content.includes('没有已应用到 PCB 的交换')), 'G27 未应用先同步提示');
		await index2.undoLastSwap();
		ok(mk2.calls.dialogs.some(d => d.content.includes('没有可撤销的交换记录')), 'G28 无台账提示');
	}

	/* ================= H. 适配层细节与补强 ================= */

	section('H. 适配层细节');

	{
		// readPageWires：嵌套折线形态 + 权威网络名兜底
		installEdaMock({
			wires: [
				{ id: 'w1', line: [[100, 100], [150, 100]] }, // 嵌套形态
				{ id: 'w2', line: [100, 200, 150, 200] }, // flat 形态，自带名空
			],
			projectNets: [{ net: 'IO2', wires: ['w2'] }],
		});
		const { readPageWires } = await import('../src/eda-adapter.ts');
		const wires = await readPageWires();
		eq(wires.length, 2, 'H1 两种折线形态都解析');
		const w1 = wires.find(w => w.id === 'w1')!;
		eq(w1.vertices.length, 2, 'H2 嵌套形态顶点数');
		eq(w1.line.join(','), '100,100,150,100', 'H3 嵌套形态归一为 flat');
		const w2 = wires.find(w => w.id === 'w2')!;
		eq(w2.authNet, 'IO2', 'H4 权威网络名兜底');
		eq(w2.ownNet, '', 'H5 自带名保持空');
	}
	{
		// 电源符号读取
		installEdaMock({ netFlags: [{ id: 'f1', net: 'GND', x: 10, y: 20 }, { id: 'f2', net: '', x: 30, y: 40 }] });
		const { readPageNetFlags } = await import('../src/eda-adapter.ts');
		const flags = await readPageNetFlags();
		eq(flags.length, 1, 'H6 无名符号跳过');
		eq(flags[0].net, 'GND', 'H7 符号网络名');
	}
	{
		// 只选引脚时反查父器件
		installEdaMock({
			comps: [
				{ id: 'c1', designator: 'J1', pins: [{ id: 'p1', pinNumber: '1', x: 0, y: 0 }, { id: 'p2', pinNumber: '2', x: 0, y: 100 }] },
				{ id: 'c2', designator: 'U2', pins: [{ id: 'p3', pinNumber: '1', x: 500, y: 0 }] },
			],
			selectedPins: ['p1'],
		});
		const { getSelectedHeaders } = await import('../src/eda-adapter.ts');
		const hs = await getSelectedHeaders();
		eq(hs.length, 1, 'H8 引脚选中反查器件');
		eq(hs[0].designator, 'J1', 'H9 反查到位号');
		eq(hs[0].pins.length, 2, 'H10 引脚表完整');
		eq(hs[0].pins[0].pinNumber, '1', 'H11 引脚号');
	}
	{
		// 配置钳位（含已移除的 syncPcb 字段被忽略）
		installEdaMock({});
		const { loadConfig } = await import('../src/eda-adapter.ts');
		(globalThis as any).eda.sys_Storage.setExtensionUserConfig('schHeaderSwapConfig', JSON.stringify({
			weightMode: 'bogus',
			maxRefineIters: -5,
			createIntervalMs: 'x',
			syncPcb: 'nope',
		}));
		const cfg = loadConfig();
		eq(cfg.weightMode, 'balanced', 'H12 非法权重档回落');
		eq(cfg.maxRefineIters, DEFAULT_CONFIG.maxRefineIters, 'H13 负精修轮数回落');
		eq(cfg.createIntervalMs, DEFAULT_CONFIG.createIntervalMs, 'H14 非法间隔回落');
	}
	{
		// PCB 阶段方案组装：锁定规则
		installEdaMock({});
		const { buildDevicePinsPlan } = await import('../src/stub-model.ts');
		const pads: Pad[] = [
			{ designator: 'U1', padNumber: '1', net: 'IO1', x: 0, y: 0 },
			{ designator: 'U1', padNumber: '2', net: 'IO2', x: 0, y: 100 },
			{ designator: 'U1', padNumber: '3', net: 'GND', x: 0, y: 200 },
			{ designator: 'U1', padNumber: '4', net: 'IO9', x: 0, y: 300 },
			{ designator: 'U1', padNumber: '5', net: 'IO9', x: 0, y: 400 },
			{ designator: 'U1', padNumber: '6', net: 'OTHER', x: 0, y: 500 }, // 不在选中集合
		];
		const selected = new Set(['IO1', 'IO2', 'GND', 'IO9']);
		const plans = buildDevicePinsPlan('U1', pads, selected, DEFAULT_CONFIG);
		eq(plans.length, 5, 'H15 只收选中网络的焊盘');
		eq(plans.find(p => p.pinNumber === '1')!.swappable, true, 'H16 普通信号可换');
		eq(plans.find(p => p.pinNumber === '3')!.lockReason, 'power', 'H17 电源锁定');
		eq(plans.find(p => p.pinNumber === '4')!.lockReason, 'duplicate-net', 'H18 重复网络锁定');
		ok(!plans.some(p => p.pinNumber === '6'), 'H19 未选网络不参与');
		const plans2 = buildDevicePinsPlan('U1', pads, selected, { ...DEFAULT_CONFIG, lockPins: 'U1.2' });
		eq(plans2.find(p => p.pinNumber === '2')!.lockReason, 'locked-user', 'H20 用户锁定');
		const plans3 = buildDevicePinsPlan('U1', pads, selected, { ...DEFAULT_CONFIG, lockPins: '1' });
		eq(plans3.find(p => p.pinNumber === '1')!.lockReason, 'locked-user', 'H21 纯引脚号锁定');
	}
	{
		// 共点焊盘（不同网络共享坐标）：飞线端点相触不计交叉
		const pads: Pad[] = [
			{ designator: 'U1', padNumber: '1', net: 'A', x: 0, y: 0 },
			{ designator: 'U1', padNumber: '2', net: 'B', x: 0, y: 0 },
			{ designator: 'U2', padNumber: '1', net: 'A', x: 1000, y: 1000 },
			{ designator: 'U2', padNumber: '2', net: 'B', x: 1000, y: -1000 },
		];
		eq(evaluateRatsnest(pads).crossings, 0, 'H22 共点端点相触不计交叉');
	}
	{
		// 匈牙利平局：任意合法排列即可
		const perm = hungarian([[1, 1], [1, 1]]);
		ok(perm[0] !== perm[1], 'H23 平局仍是合法排列');
	}
	{
		// solveForDevice 直接驱动：newNet 是 oldNet 的双射
		const { buildDevicePinsPlan } = await import('../src/stub-model.ts');
		const { solveForDevice } = await import('../src/index.ts');
		const boardPads: Pad[] = [];
		for (let i = 1; i <= 6; i++) {
			boardPads.push({ designator: 'J1', padNumber: String(i), net: `IO${i}`, x: 2000, y: 100 * i, padId: `pad-J1-${i}` });
			boardPads.push({ designator: 'U2', padNumber: `PA${i}`, net: `IO${i}`, x: 3000, y: 700 - 100 * i, padId: `pad-U2-${i}` });
		}
		const pins = buildDevicePinsPlan('U2', boardPads, new Set(['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6']), DEFAULT_CONFIG);
		const solved = solveForDevice('U2', pins, boardPads, 'balanced', 4);
		eq(solved.changedCount, 6, 'H24 solveForDevice 6 脚交换');
		const changed = pins.filter(p => p.newNet !== p.oldNet);
		const olds = changed.map(p => p.oldNet).sort();
		const news = changed.map(p => p.newNet).sort();
		eq(news.join(','), olds.join(','), 'H25 交换后网络集合不变（双射）');
	}
	{
		// 写后刷新：主路径=关开 PCB 页签（V3.2 程序化改网后交互层半成品事务态，
		// 实测关开页签原生重建；2026-09-22 用户实机路径验证）
		const mk = installEdaMock({});
		const { createPcbHooks } = await import('../src/eda-adapter.ts');
		await createPcbHooks().refreshPcbCanvas('pcb-uuid-1', 'tab-old');
		ok(mk.calls.editor.includes('close:tab-old'), 'H26 刷新先关旧页签');
		ok(mk.calls.editor.includes('open:pcb-uuid-1'), 'H27 重开 PCB 页签');
	}
	{
		// 退级：无 closeDocument 的客户端走 ratline 循环
		const mk = installEdaMock({ noCloseDocument: true });
		const { createPcbHooks } = await import('../src/eda-adapter.ts');
		await createPcbHooks().refreshPcbCanvas('pcb-uuid-1');
		ok(!mk.calls.editor.some(e => e.startsWith('close:')), 'H28 无关闭接口时不关页签');
		eq(mk.calls.ratlineRefresh, 1, 'H29 退级走 ratline start/stop 循环');
	}

	/* ---------------- 汇总 ---------------- */

	console.log(`\n通过 ${pass}，失败 ${fail}`);
	if (fail > 0) {
		console.error(failures.join('\n'));
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
