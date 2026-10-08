import type { Seg } from './metrics.ts';
import type { RoutePad, RouteRect, RoutingSummary } from './router.ts';
/**
 * 排插引脚-网络指派求解器 / Header pin-net assignment solver
 *
 * 两级求解：
 * 1. 代价矩阵（引脚位置 -> 网络其它端点最近距离）上跑匈牙利算法得最优指派；
 * 2. 以真实目标函数（全板鼠线 MST 总长 + 交叉数×权重）做 2-opt 交换局部
 *    搜索精修——初始代价只是"最近端点"代理，精修才能压交叉。
 * 纯逻辑，可离线测试。坐标 mil。
 */
import type { Pad, RatsnestMetrics, WeightMode } from './types.ts';
import { dist } from './geometry.ts';
import { countCrossings, evaluateRatsnest, netSegments } from './metrics.ts';
import { createRoutingSession, DEFAULT_ROUTING_WEIGHTS, estimateEscapeCost } from './router.ts';

/** 交叉数折算线长（mil/处）：偏重交叉档让任何一处交叉都值得绕远 */
export const CROSSING_WEIGHT_MIL: Record<WeightMode, number> = {
	crossings: 20000,
	balanced: 800,
	length: 10,
};

/** 内存布线精修的时间预算（ms）：超时截断当轮（小板不受影响） */
const ROUTE_TIME_BUDGET_MS = 10000;
/** 参与布线评估的可换引脚上限（超过回退鼠线模型） */
const MAX_ROUTING_NETS = 64;

/** 可换引脚槽位：焊盘（位置）+ 当前网络 */
export interface Slot {
	pad: Pad;
	net: string;
}

/** 可换网络：其它端点（同网络且不属于本排插的焊盘） */
export interface SwappableNet {
	net: string;
	others: Pad[];
}

export interface SolveOptions {
	weightMode: WeightMode;
	maxRefineIters: number;
	/** 代价模型：缺省 'ratsnest'（向后兼容）；routing/auto 用内存局部布线评估 */
	costModel?: 'ratsnest' | 'routing' | 'auto';
}

export interface SolveResult {
	/** assignment[i] = 槽位 i 分到的网络下标（nets 下标） */
	assignment: number[];
	changedCount: number;
	scoreBefore: number;
	scoreAfter: number;
	metricsBefore: RatsnestMetrics;
	metricsAfter: RatsnestMetrics;
	/** 实际使用的代价模型 */
	costModelUsed: 'ratsnest' | 'routing';
	/** 局部布线指标（costModelUsed='routing' 时存在） */
	routing?: { before: RoutingSummary; after: RoutingSummary };
	/** 布线模型提示（降级原因/精修截断） */
	routingNotes: string[];
}

/**
 * 方阵最小代价指派（匈牙利算法，带电位法 O(n³)）。
 * cost[行=槽位][列=网络] -> 每行分到不同列，返回 行 -> 列。
 */
export function hungarian(cost: number[][]): number[] {
	const n = cost.length;
	if (n === 0)
		return [];
	const INF = Number.POSITIVE_INFINITY;
	// 1-indexed：u/v 为行/列电位，p[j] = 列 j 当前匹配的行（p[0] 为增广起点）
	const u: number[] = Array.from({ length: n + 1 }, () => 0);
	const v: number[] = Array.from({ length: n + 1 }, () => 0);
	const p: number[] = Array.from({ length: n + 1 }, () => 0);
	const way: number[] = Array.from({ length: n + 1 }, () => 0);
	for (let i = 1; i <= n; i++) {
		p[0] = i;
		let j0 = 0;
		const minv: number[] = Array.from({ length: n + 1 }, () => INF);
		const used: boolean[] = Array.from({ length: n + 1 }, () => false);
		do {
			used[j0] = true;
			const i0 = p[j0];
			let delta = INF;
			let j1 = 0;
			for (let j = 1; j <= n; j++) {
				if (used[j])
					continue;
				const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
				if (cur < minv[j]) {
					minv[j] = cur;
					way[j] = j0;
				}
				if (minv[j] < delta) {
					delta = minv[j];
					j1 = j;
				}
			}
			for (let j = 0; j <= n; j++) {
				if (used[j]) {
					u[p[j]] += delta;
					v[j] -= delta;
				}
				else {
					minv[j] -= delta;
				}
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0];
			p[j0] = p[j1];
			j0 = j1;
		} while (j0);
	}
	const assignment: number[] = Array.from({ length: n }, () => -1);
	for (let j = 1; j <= n; j++) {
		if (p[j] > 0)
			assignment[p[j] - 1] = j - 1;
	}
	return assignment;
}

/** 指派是否为恒等（网络原地不动） */
function isIdentity(assignment: number[]): boolean {
	return assignment.every((v, i) => v === i);
}

/** 按指派把排插可换焊盘的网络替换后的全板焊盘表（评估用，不改真实数据） */
export function virtualBoardPads(boardPads: Pad[], headerDesignator: string, slots: Slot[], nets: SwappableNet[], assignment: number[]): Pad[] {
	const headerPadIds = new Set(slots.map(s => s.pad.padId ?? `${s.pad.designator}.${s.pad.padNumber}`));
	const virtual = boardPads.map((p) => {
		const key = p.padId ?? `${p.designator}.${p.padNumber}`;
		if (p.designator !== headerDesignator || !headerPadIds.has(key))
			return p;
		const slotIdx = slots.findIndex(s => (s.pad.padId ?? `${s.pad.designator}.${s.pad.padNumber}`) === key);
		const netIdx = assignment[slotIdx];
		return { ...p, net: netIdx >= 0 ? nets[netIdx].net : p.net };
	});
	return virtual;
}

/* ---------------- 器件几何（布线评估用） ---------------- */

/** 器件引脚场几何摘要：间距/阻挡半径/包围盒/体内阻挡区 */
export interface DeviceFacts {
	/** 中位最近邻焊盘间距（mil） */
	pitch: number;
	/** 焊盘阻挡半径（mil） */
	padR: number;
	bbox: { x0: number; y0: number; x1: number; y1: number };
	/** 体内阻挡区（仅 ring 型：QFP/单排连接器等边沿引脚器件；BGA 阵列不设） */
	body?: RouteRect;
	kind: 'ring' | 'array' | 'sparse';
}

/** 从器件焊盘集推导几何：中位 NN 间距；内部有焊盘=BGA 型阵列（不设体阻挡，留扇出通道），否则边沿环型 */
export function deriveDeviceFacts(pads: Pad[]): DeviceFacts | undefined {
	if (pads.length < 2)
		return undefined;
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const p of pads) {
		if (p.x < x0)
			x0 = p.x;
		if (p.y < y0)
			y0 = p.y;
		if (p.x > x1)
			x1 = p.x;
		if (p.y > y1)
			y1 = p.y;
	}
	const nns: number[] = [];
	for (let i = 0; i < pads.length; i++) {
		let best = Number.POSITIVE_INFINITY;
		for (let j = 0; j < pads.length; j++) {
			if (i === j)
				continue;
			const d = Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y);
			if (d > 0.01 && d < best)
				best = d;
		}
		if (Number.isFinite(best))
			nns.push(best);
	}
	nns.sort((a, b) => a - b);
	const pitch = nns.length ? nns[Math.floor(nns.length / 2)] : 10;
	const bbox = { x0, y0, x1, y1 };
	let interior = 0;
	for (const p of pads) {
		const dEdge = Math.min(p.x - x0, x1 - p.x, p.y - y0, y1 - p.y);
		if (dEdge > pitch * 1.5)
			interior++;
	}
	const kind: DeviceFacts['kind'] = pads.length < 4 ? 'sparse' : interior >= 2 ? 'array' : 'ring';
	const padR = Math.min(30, Math.max(4, pitch * 0.3));
	let body: RouteRect | undefined;
	if (kind === 'ring' && x1 - x0 >= pitch * 3 && y1 - y0 >= pitch * 3) {
		// 体内阻挡：包围盒内缩 0.75 间距（不覆盖边沿焊盘的铜）；
		// 仅对横竖都 ≥3 间距的环型器件（QFP 等）生效——单排/双排连接器内缩会吞掉
		// 自身引脚的出线走廊，不设体阻挡（焊盘障碍已足够）
		const inset = pitch * 0.75;
		body = { x0: x0 + inset, y0: y0 + inset, x1: x1 - inset, y1: y1 - inset };
	}
	return { pitch, padR, bbox, body, kind };
}

/** 全板器件几何表（designator -> facts；焊盘数 <2 的器件不入表） */
export function deriveDeviceFactsMap(boardPads: Pad[]): Map<string, DeviceFacts> {
	const byDev = new Map<string, Pad[]>();
	for (const p of boardPads) {
		if (!p.designator)
			continue;
		const list = byDev.get(p.designator) ?? [];
		list.push(p);
		byDev.set(p.designator, list);
	}
	const map = new Map<string, DeviceFacts>();
	for (const [des, pads] of byDev) {
		const f = deriveDeviceFacts(pads);
		if (f)
			map.set(des, f);
	}
	return map;
}

/** 环型器件边沿引脚的出线方向（垂直边向外）；内部/阵列/稀疏引脚无约束 */
export function escapeOf(facts: DeviceFacts, pad: { x: number; y: number }): { dx: number; dy: number } | undefined {
	const { bbox, pitch } = facts;
	const dL = pad.x - bbox.x0;
	const dR = bbox.x1 - pad.x;
	const dB = pad.y - bbox.y0;
	const dT = bbox.y1 - pad.y;
	const m = Math.min(dL, dR, dB, dT);
	if (m > pitch * 0.6)
		return undefined;
	if (m === dL)
		return { dx: -1, dy: 0 };
	if (m === dR)
		return { dx: 1, dy: 0 };
	if (m === dB)
		return { dx: 0, dy: -1 };
	return { dx: 0, dy: 1 };
}

/* ---------------- 内存布线代价模型求解 ---------------- */

/** 布线求解结果（fellBack 时调用方回退鼠线模型） */
export interface RoutingSolveOutcome {
	assignment: number[];
	routing: { before: RoutingSummary; after: RoutingSummary };
	notes: string[];
}

function solveRoutingSwap(slots: Slot[], nets: SwappableNet[], boardPads: Pad[], headerDesignator: string, maxRefineIters: number): RoutingSolveOutcome | { fellBack: string } {
	const k = slots.length;
	if (k > MAX_ROUTING_NETS)
		return { fellBack: `可换引脚 ${k} 个超过布线评估上限 ${MAX_ROUTING_NETS}` };
	const factsByDevice = deriveDeviceFactsMap(boardPads);
	const devFacts = factsByDevice.get(headerDesignator);
	if (!devFacts)
		return { fellBack: '器件引脚场未识别（焊盘 <2）' };
	const gridMil = Math.min(25, Math.max(5, Math.round(devFacts.pitch * 0.5)));
	const weights = { ...DEFAULT_ROUTING_WEIGHTS, gridMil };
	const routePads: RoutePad[] = boardPads.map((p) => {
		const f = factsByDevice.get(p.designator);
		return { x: p.x, y: p.y, r: f ? f.padR : Math.min(30, Math.max(4, gridMil * 0.8)), net: (p.net ?? '').trim() };
	});
	const bodies: RouteRect[] = [];
	for (const f of factsByDevice.values()) {
		if (f.body)
			bodies.push(f.body);
	}
	const escapes = slots.map(s => escapeOf(devFacts, s.pad) ?? undefined);
	const routed = nets.map(n => n.others.length > 0);

	// 1) 匈牙利初解：绕行代价估计（穿体指派从初解起就被惩罚）
	const cost = slots.map(s => nets.map(n => (n.others.length ? estimateEscapeCost(s.pad, n.others, bodies) : 0)));
	const assignment = hungarian(cost);

	const buildReqs = (asg: number[]) => {
		const reqs = [];
		for (let slotIdx = 0; slotIdx < k; slotIdx++) {
			const netIdx = asg[slotIdx];
			if (!routed[netIdx])
				continue;
			reqs.push({ net: nets[netIdx].net, from: slots[slotIdx].pad, fromEscape: escapes[slotIdx], fromR: devFacts.padR, targets: nets[netIdx].others });
		}
		return reqs;
	};

	// 2) 会话布线 + 2-opt 增量精修（换网只重布涉及的两条）
	const session = createRoutingSession(buildReqs(assignment), routePads, bodies, weights);
	if ('fellBack' in session)
		return session;
	session.routeInitial();
	let best = session.summary().score;
	const notes: string[] = [];
	const t0 = Date.now();
	let aborted = false;
	for (let pass = 0; pass < Math.max(0, maxRefineIters); pass++) {
		let improved = false;
		for (let i = 0; i < k && !aborted; i++) {
			for (let j = i + 1; j < k; j++) {
				const a = assignment[i];
				const b = assignment[j];
				if (a === b || (!routed[a] && !routed[b]))
					continue;
				if (Date.now() - t0 > ROUTE_TIME_BUDGET_MS) {
					aborted = true;
					notes.push(`布线精修超过 ${ROUTE_TIME_BUDGET_MS / 1000}s，当轮截断`);
					break;
				}
				const snap = session.snapshot();
				session.setFrom(nets[a].net, slots[j].pad, escapes[j]);
				session.setFrom(nets[b].net, slots[i].pad, escapes[i]);
				const pair = [a, b].filter(idx => routed[idx]).map(idx => nets[idx].net);
				session.rerouteNets(pair);
				if (session.summary().score < best - 1e-9) {
					assignment[i] = b;
					assignment[j] = a;
					best = session.summary().score;
					improved = true;
				}
				else {
					session.restore(snap);
				}
			}
		}
		session.fullReroute();
		best = session.summary().score;
		if (aborted || !improved)
			break;
	}

	// 3) 与恒等指派比较（无真实布线收益则保持原状）
	const identity = slots.map((_, i) => i);
	const sIdent = createRoutingSession(buildReqs(identity), routePads, bodies, weights);
	if ('fellBack' in sIdent)
		return sIdent;
	sIdent.routeInitial();
	const before = sIdent.summary();
	if (best >= before.score - 1e-9) {
		notes.push('布线评估无收益，保持原状');
		return { assignment: identity, routing: { before, after: before }, notes };
	}
	return { assignment, routing: { before, after: session.summary() }, notes };
}

/** 主求解入口。slots 与 nets 一一对应（同序：slots[i].net === nets[i].net） */
export function solveHeaderSwap(slots: Slot[], nets: SwappableNet[], boardPads: Pad[], headerDesignator: string, opts: SolveOptions): SolveResult {
	const k = slots.length;
	const identity = slots.map((_, i) => i);
	if (k <= 1 || nets.length !== k) {
		const metrics = evaluateRatsnest(boardPads);
		return {
			assignment: identity,
			changedCount: 0,
			scoreBefore: 0,
			scoreAfter: 0,
			metricsBefore: metrics,
			metricsAfter: metrics,
			costModelUsed: 'ratsnest',
			routingNotes: [],
		};
	}

	// ---- 0. 内存局部布线代价模型（v0.4.0）：可路由性（过孔/绕行）取代直连线代理 ----
	const costModel = opts.costModel ?? 'ratsnest';
	if (costModel === 'routing' || costModel === 'auto') {
		const r = solveRoutingSwap(slots, nets, boardPads, headerDesignator, opts.maxRefineIters);
		if ('fellBack' in r) {
			if (costModel === 'routing')
				throw new Error(`布线评估不可用：${r.fellBack}（可把设置中代价模型改回 auto/鼠线）`);
		}
		else {
			const metricsBefore = evaluateRatsnest(boardPads);
			const same = r.assignment.every((v, i) => v === i);
			const metricsAfter = same
				? metricsBefore
				: evaluateRatsnest(virtualBoardPads(boardPads, headerDesignator, slots, nets, r.assignment));
			return {
				assignment: r.assignment,
				changedCount: r.assignment.reduce((n, netIdx, i) => n + (netIdx !== i ? 1 : 0), 0),
				scoreBefore: r.routing.before.score,
				scoreAfter: r.routing.after.score,
				metricsBefore,
				metricsAfter,
				costModelUsed: 'routing',
				routing: r.routing,
				routingNotes: r.notes,
			};
		}
	}
	const routingNotes: string[] = [];
	if (costModel === 'auto')
		routingNotes.push('布线评估不可用，回退鼠线模型');

	const w = CROSSING_WEIGHT_MIL[opts.weightMode];

	// ---- 静态部分：不参与交换的网络（含锁定排插脚）的飞线边，一次算好 ----
	const swapNetSet = new Set(nets.map(n => n.net));
	const staticSegs: Seg[] = [];
	const staticGroups = new Map<string, Array<{ x: number; y: number }>>();
	for (const p of boardPads) {
		const net = (p.net ?? '').trim();
		if (!net || swapNetSet.has(net))
			continue;
		const list = staticGroups.get(net) ?? [];
		list.push({ x: p.x, y: p.y });
		staticGroups.set(net, list);
	}
	for (const [net, pts] of staticGroups) {
		staticSegs.push(...netSegments(pts, net).segs);
	}

	// ---- 动态部分：每个可换网络在当前指派下的飞线（含排插侧焊盘） ----
	const dynOf = (netIdx: number, pad: Pad) => {
		const n = nets[netIdx];
		const pts = n.others.map(o => ({ x: o.x, y: o.y }));
		pts.push({ x: pad.x, y: pad.y });
		return netSegments(pts, n.net);
	};
	const dynSegs: Seg[][] = [];
	const dynLen: number[] = [];
	/** 按指派重建全部动态飞线（网络 netIdx 的排插焊盘 = 它分到的槽位焊盘） */
	const rebuildDyn = (assignment: number[]): void => {
		dynSegs.length = 0;
		dynLen.length = 0;
		for (let netIdx = 0; netIdx < k; netIdx++) {
			const slotIdx = assignment.indexOf(netIdx);
			const d = dynOf(netIdx, slots[slotIdx].pad);
			dynSegs.push(d.segs);
			dynLen.push(d.lengthMil);
		}
	};
	rebuildDyn(identity);

	/** (a,b) 两个网络相对"其余全部飞线（静态+其它动态）"的交叉与长度贡献 */
	const contribution = (a: number, b: number, segsA: Seg[], segsB: Seg[], lenA: number, lenB: number): number => {
		let cross = countCrossings(segsA, staticSegs) + countCrossings(segsB, staticSegs) + countCrossings(segsA, segsB);
		for (let l = 0; l < k; l++) {
			if (l === a || l === b)
				continue;
			cross += countCrossings(segsA, dynSegs[l]) + countCrossings(segsB, dynSegs[l]);
		}
		return w * cross + lenA + lenB;
	};

	/** 全指派真实得分（O(全量)，仅初末各算一次） */
	const totalScore = (assignment: number[]): number => {
		const virt = virtualBoardPads(boardPads, headerDesignator, slots, nets, assignment);
		const groups = new Map<string, Array<{ x: number; y: number }>>();
		for (const p of virt) {
			const net = (p.net ?? '').trim();
			if (!net)
				continue;
			const list = groups.get(net) ?? [];
			list.push({ x: p.x, y: p.y });
			groups.set(net, list);
		}
		let len = 0;
		const segs: Seg[] = [];
		for (const [net, pts] of groups) {
			const r = netSegments(pts, net);
			len += r.lengthMil;
			segs.push(...r.segs);
		}
		let cross = 0;
		for (let i = 0; i < segs.length; i++) {
			for (let j = i + 1; j < segs.length; j++) {
				if (segs[i].net === segs[j].net)
					continue;
				// segmentsIntersect 已含在 countCrossings 内，这里直接复用单对判定
				if (countCrossings([segs[i]], [segs[j]]) > 0)
					cross++;
			}
		}
		return w * cross + len;
	};

	// ---- 1. 匈牙利初始指派（最近端点距离代价；悬空网络代价 0） ----
	const cost: number[][] = slots.map((s) => {
		return nets.map((n) => {
			if (!n.others.length)
				return 0;
			let best = Number.POSITIVE_INFINITY;
			for (const o of n.others) {
				const d = dist(s.pad.x, s.pad.y, o.x, o.y);
				if (d < best)
					best = d;
			}
			return best;
		});
	});
	let assignment = hungarian(cost);
	rebuildDyn(assignment);

	// ---- 2. 2-opt 精修（真实目标函数，增量评估） ----
	for (let pass = 0; pass < Math.max(0, opts.maxRefineIters); pass++) {
		let improved = false;
		for (let i = 0; i < k; i++) {
			for (let j = i + 1; j < k; j++) {
				const a = assignment[i];
				const b = assignment[j];
				if (a === b)
					continue;
				const oldA = dynSegs[a];
				const oldB = dynSegs[b];
				const newA = dynOf(a, slots[j].pad); // 网络 a 的排插焊盘换到槽位 j
				const newB = dynOf(b, slots[i].pad);
				const before = contribution(a, b, oldA, oldB, dynLen[a], dynLen[b]);
				const after = contribution(a, b, newA.segs, newB.segs, newA.lengthMil, newB.lengthMil);
				if (after < before - 1e-9) {
					assignment[i] = b;
					assignment[j] = a;
					dynSegs[a] = newA.segs;
					dynLen[a] = newA.lengthMil;
					dynSegs[b] = newB.segs;
					dynLen[b] = newB.lengthMil;
					improved = true;
				}
			}
		}
		if (!improved)
			break;
	}

	// ---- 3. 与恒等指派比较：没有真实收益就保持原状（少动为佳） ----
	const scoreBefore = totalScore(identity);
	let scoreAfter = totalScore(assignment);
	if (scoreAfter > scoreBefore - 1e-9) {
		assignment = identity;
		scoreAfter = scoreBefore;
	}

	const metricsBefore = evaluateRatsnest(boardPads);
	const metricsAfter = isIdentity(assignment)
		? metricsBefore
		: evaluateRatsnest(virtualBoardPads(boardPads, headerDesignator, slots, nets, assignment));
	const changedCount = assignment.reduce((n, netIdx, i) => n + (netIdx !== i ? 1 : 0), 0);

	return { assignment, changedCount, scoreBefore, scoreAfter, metricsBefore, metricsAfter, costModelUsed: 'ratsnest', routingNotes };
}
