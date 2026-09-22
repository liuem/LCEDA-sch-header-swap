import type { Seg } from './metrics.ts';
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

/** 交叉数折算线长（mil/处）：偏重交叉档让任何一处交叉都值得绕远 */
export const CROSSING_WEIGHT_MIL: Record<WeightMode, number> = {
	crossings: 20000,
	balanced: 800,
	length: 10,
};

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
}

export interface SolveResult {
	/** assignment[i] = 槽位 i 分到的网络下标（nets 下标） */
	assignment: number[];
	changedCount: number;
	scoreBefore: number;
	scoreAfter: number;
	metricsBefore: RatsnestMetrics;
	metricsAfter: RatsnestMetrics;
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
		};
	}

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

	return { assignment, changedCount, scoreBefore, scoreAfter, metricsBefore, metricsAfter };
}
