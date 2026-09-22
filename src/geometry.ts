/**
 * 几何工具 / Geometry helpers
 *
 * 与 conn-export 同源的导线顶点解析与"点是否落在导线段上"判定，
 * 外加本插件需要的点距/线段相交原语。原理图画布坐标为整数网格，容差 eps=1。
 */

/** 多段线坐标组 -> 顶点列表（兼容 [x1,y1,...] 与 [[x,y],...] 两种形态） */
export function wireVertices(line: number[] | Array<Array<number>> | undefined): Array<{ x: number; y: number }> {
	const pts: Array<{ x: number; y: number }> = [];
	if (!Array.isArray(line))
		return pts;
	if (typeof line[0] === 'number') {
		for (let i = 0; i + 1 < (line as number[]).length; i += 2)
			pts.push({ x: Number(line[i]), y: Number(line[i + 1]) });
	}
	else {
		for (const p of line as Array<Array<number>>)
			pts.push({ x: Number(p?.[0]), y: Number(p?.[1]) });
	}
	return pts.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** 折线转 flat 数组（删建回退时重建导线用） */
export function verticesToFlat(pts: Array<{ x: number; y: number }>): number[] {
	const out: number[] = [];
	for (const p of pts) {
		out.push(Math.round(p.x), Math.round(p.y));
	}
	return out;
}

/** 点到线段距离的平方 */
export function distPointToSegSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
	t = Math.max(0, Math.min(1, t));
	const ex = ax + t * dx - px;
	const ey = ay + t * dy - py;
	return ex * ex + ey * ey;
}

/** 点是否落在导线段上（eps 容差，画布整数坐标默认 1） */
export function pointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, eps = 1): boolean {
	return distPointToSegSq(px, py, ax, ay, bx, by) <= eps * eps;
}

/** 两线段是否规范相交（端点相触不算，用于鼠线交叉计数） */
export function segmentsIntersect(a1x: number, a1y: number, a2x: number, a2y: number, b1x: number, b1y: number, b2x: number, b2y: number): boolean {
	const d = (a2x - a1x) * (b2y - b1y) - (a2y - a1y) * (b2x - b1x);
	if (Math.abs(d) < 1e-12)
		return false;
	const t = ((b1x - a1x) * (b2y - b1y) - (b1y - a1y) * (b2x - b1x)) / d;
	const u = ((b1x - a1x) * (a2y - a1y) - (b1y - a1y) * (a2x - a1x)) / d;
	return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** 两点欧氏距离 */
export function dist(ax: number, ay: number, bx: number, by: number): number {
	return Math.hypot(ax - bx, ay - by);
}
