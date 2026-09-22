/**
 * 鼠线几何评估 / Ratsnest metrics
 *
 * EDA 不暴露鼠线几何，按焊盘坐标自行估算（与 ai-pcb-autoplace 的
 * metrics 同源思路）：每网络 Prim 最小生成树作为飞线拓扑，总长 = 各网
 * MST 边长和；交叉 = 不同网络的 MST 边两两规范相交计数。
 * 单位 mil。纯几何，可离线测试。
 */
import type { Pad, RatsnestMetrics } from './types.ts';
import { segmentsIntersect } from './geometry.ts';

/** 一条飞线边（携带所属网络） */
export interface Seg {
	net: string;
	ax: number;
	ay: number;
	bx: number;
	by: number;
}

/** Prim 最小生成树边（点数组上的索引对），n<2 返回空 */
export function mstEdges(pts: Array<{ x: number; y: number }>): Array<[number, number]> {
	const n = pts.length;
	const edges: Array<[number, number]> = [];
	if (n < 2)
		return edges;
	const inTree: boolean[] = Array.from({ length: n }, () => false);
	inTree[0] = true;
	const bestDist: number[] = Array.from({ length: n }, () => Number.POSITIVE_INFINITY);
	const bestFrom: number[] = Array.from({ length: n }, () => 0);
	for (let i = 1; i < n; i++) {
		const dx = pts[i].x - pts[0].x;
		const dy = pts[i].y - pts[0].y;
		bestDist[i] = dx * dx + dy * dy;
	}
	for (let k = 1; k < n; k++) {
		let mi = -1;
		for (let i = 0; i < n; i++) {
			if (!inTree[i] && (mi === -1 || bestDist[i] < bestDist[mi]))
				mi = i;
		}
		edges.push([bestFrom[mi], mi]);
		inTree[mi] = true;
		for (let i = 0; i < n; i++) {
			if (!inTree[i]) {
				const dx = pts[i].x - pts[mi].x;
				const dy = pts[i].y - pts[mi].y;
				const d2 = dx * dx + dy * dy;
				if (d2 < bestDist[i]) {
					bestDist[i] = d2;
					bestFrom[i] = mi;
				}
			}
		}
	}
	return edges;
}

/** 单个网络（点集）的 MST 飞线边与总长；超大网络截断采样防 O(n²) 爆炸 */
export function netSegments(pts: Array<{ x: number; y: number }>, net: string, maxPads = 64): { segs: Seg[]; lengthMil: number } {
	const sampled = pts.length > maxPads ? pts.slice(0, maxPads) : pts;
	const segs: Seg[] = [];
	let lengthMil = 0;
	for (const [i, j] of mstEdges(sampled)) {
		segs.push({ net, ax: sampled[i].x, ay: sampled[i].y, bx: sampled[j].x, by: sampled[j].y });
		lengthMil += Math.hypot(sampled[i].x - sampled[j].x, sampled[i].y - sampled[j].y);
	}
	return { segs, lengthMil };
}

/** 按网络分组焊盘坐标 */
export function padsByNet(pads: Pad[]): Map<string, Array<{ x: number; y: number }>> {
	const map = new Map<string, Array<{ x: number; y: number }>>();
	for (const p of pads) {
		const net = (p.net ?? '').trim();
		if (!net)
			continue;
		const list = map.get(net) ?? [];
		list.push({ x: p.x, y: p.y });
		map.set(net, list);
	}
	return map;
}

/** 两组飞线边之间的交叉数（不同网络才算） */
export function countCrossings(a: Seg[], b: Seg[]): number {
	let n = 0;
	for (const sa of a) {
		for (const sb of b) {
			if (sa.net === sb.net)
				continue;
			if (segmentsIntersect(sa.ax, sa.ay, sa.bx, sa.by, sb.ax, sb.ay, sb.bx, sb.by))
				n++;
		}
	}
	return n;
}

/** 全板鼠线指标（便捷封装：总 MST 长度 + 跨网交叉数） */
export function evaluateRatsnest(pads: Pad[], maxCrossEdges = 4000): RatsnestMetrics {
	const groups = padsByNet(pads);
	let totalLengthMil = 0;
	let crossings = 0;
	const allSegs: Seg[] = [];
	for (const [net, pts] of groups) {
		const { segs, lengthMil } = netSegments(pts, net);
		totalLengthMil += lengthMil;
		allSegs.push(...segs);
	}
	const segs = allSegs.length > maxCrossEdges ? allSegs.slice(0, maxCrossEdges) : allSegs;
	for (let i = 0; i < segs.length; i++) {
		for (let j = i + 1; j < segs.length; j++) {
			if (segs[i].net === segs[j].net)
				continue;
			if (segmentsIntersect(segs[i].ax, segs[i].ay, segs[i].bx, segs[i].by, segs[j].ax, segs[j].ay, segs[j].bx, segs[j].by))
				crossings++;
		}
	}
	return { totalLengthMil: Math.round(totalLengthMil * 100) / 100, crossings };
}
