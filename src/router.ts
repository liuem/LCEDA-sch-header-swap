/**
 * 内存局部自动布线评估 / In-memory local routing evaluation
 *
 * 背景：鼠线 MST+交叉数把芯片当透明（直线可穿体），四边出线器件（QFP/FPGA）
 * 的引脚实际只能垂直于边出线——直连线最优的指派真实布线全交叉、全打过孔
 * （商店一星差评根因）。本模块做一个保守的局部布线器当"真值"：
 * - 两层网格（顶/底），A* 迷宫布线，步进=网格 mil、拐弯/换层（过孔）带代价；
 * - 焊盘铜（圆形近似）与器件体/引脚环内部为障碍（两层都挡——保守模型，
 *   换层自由度用过孔代价表达，不模拟穿体布线）；
 * - 器件引脚可带**出线方向约束**：路由的第一步必须沿边向外；
 * - 顺序布线：先布短线，已布路径成为后续障碍（同层不让路、换层要过孔）——
 *   这正是"交叉要用过孔换层解决"的来源；失败网优先重排轮次重试（rip-up）。
 *
 * 纯逻辑、确定性、无 eda 依赖，可离线测试。坐标 mil。
 */

/** 点（mil） */
export interface RoutePt {
	x: number;
	y: number;
}

/** 焊盘障碍：圆形近似铜占地 + 所属网络（交换集内网络的焊盘布本网时放行） */
export interface RoutePad {
	x: number;
	y: number;
	/** 阻挡半径 mil */
	r: number;
	/** 空串 = 无网络（永远阻挡） */
	net: string;
}

/** 矩形阻挡区（器件体/引脚环内部，两层都挡） */
export interface RouteRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** 单条布线需求：器件引脚 -> 本网络其它端点（命中任一即连通） */
export interface RouteNetReq {
	net: string;
	from: RoutePt;
	/** 出线方向（正交单位向量）；缺省 = 无约束（内部脚/异形器件） */
	fromEscape?: { dx: number; dy: number };
	/**
	 * 起点焊盘半径（mil）：指派虚拟化后起点焊盘的原网络标签 ≠ 正在布的网络，
	 *  起点邻域按坐标放行（不依赖网络标签），缺省 = 不额外放行
	 */
	fromR?: number;
	targets: RoutePt[];
}

export interface RoutingWeights {
	gridMil: number;
	/** 过孔折算线长 mil/个 */
	viaPenaltyMil: number;
	/** 拐弯折算线长 mil/处 */
	bendPenaltyMil: number;
	/** 未布通折算线长 mil/条（主导项） */
	unroutedPenaltyMil: number;
}

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = {
	gridMil: 10,
	viaPenaltyMil: 300,
	bendPenaltyMil: 8,
	unroutedPenaltyMil: 5000,
};

/** 布线网格尺寸上限（每层格数）；超限先加倍网格距降级，仍超限报 fellBack */
const MAX_CELLS_PER_LAYER = 80000;
const GRID_DEGRADE_STEPS = 3;

/** 一条成功路径（pts 为途经格心序列，含起止） */
export interface RoutedPath {
	net: string;
	pts: RoutePt[];
	vias: number;
	lengthMil: number;
}

/** 布线结果摘要 */
export interface RoutingSummary {
	routed: number;
	unrouted: number;
	vias: number;
	lengthMil: number;
	/** unroutedPenalty*未布通 + viaPenalty*过孔 + 总长 */
	score: number;
	gridMil: number;
	gridW: number;
	gridH: number;
}

export interface RoutingResult extends RoutingSummary {
	paths: RoutedPath[];
}

/** 降级原因（网格放不下等），调用方据此回退鼠线模型 */
export interface RoutingFallback {
	fellBack: string;
}

/* ---------------- 网格世界 ---------------- */

interface World {
	gx0: number;
	gy0: number;
	gw: number;
	gh: number;
	w: RoutingWeights;
	/** 阻挡表：每格两层；0=通 1=静态障碍(焊盘/体) 2=已布路径占用 */
	block: Uint8Array;
	/** 交换集网络焊盘格（两层）-> 网络名：布该网时临时放行 */
	padNet: Map<number, string>;
}

const DIRS: Array<{ dx: number; dy: number }> = [
	{ dx: 1, dy: 0 },
	{ dx: -1, dy: 0 },
	{ dx: 0, dy: 1 },
	{ dx: 0, dy: -1 },
];
/** 状态方向码：0=起点(未移动) 1..4 与 DIRS 对应 */
function dirCode(dx: number, dy: number): number {
	for (let i = 0; i < 4; i++) {
		if (DIRS[i].dx === dx && DIRS[i].dy === dy)
			return i + 1;
	}
	return 0;
}

function buildWorld(reqs: RouteNetReq[], pads: RoutePad[], bodies: RouteRect[], w: RoutingWeights): World | RoutingFallback {
	let gridMil = w.gridMil;
	for (let step = 0; step <= GRID_DEGRADE_STEPS; step++) {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const r of reqs) {
			for (const p of [r.from, ...r.targets]) {
				if (p.x < minX)
					minX = p.x;
				if (p.y < minY)
					minY = p.y;
				if (p.x > maxX)
					maxX = p.x;
				if (p.y > maxY)
					maxY = p.y;
			}
		}
		if (!Number.isFinite(minX))
			return { fellBack: 'no endpoints' };
		const margin = Math.max(4 * gridMil, 100);
		const gx0 = minX - margin;
		const gy0 = minY - margin;
		const gw = Math.ceil((maxX + margin - gx0) / gridMil) + 1;
		const gh = Math.ceil((maxY + margin - gy0) / gridMil) + 1;
		if (gw * gh <= MAX_CELLS_PER_LAYER && gw >= 4 && gh >= 4) {
			const world: World = { gx0, gy0, gw, gh, w: { ...w, gridMil }, block: new Uint8Array(gw * gh * 2), padNet: new Map() };
			stampObstacles(world, reqs, pads, bodies);
			return world;
		}
		if (step === GRID_DEGRADE_STEPS)
			return { fellBack: `grid too large (${gw}x${gh} @${gridMil}mil)` };
		gridMil *= 2;
	}
	return { fellBack: 'grid too large' };
}

/** 静态障碍落格：焊盘圆（按格心距判定）+ 矩形内部；交换集网络焊盘登记 padNet */
function stampObstacles(world: World, reqs: RouteNetReq[], pads: RoutePad[], bodies: RouteRect[]): void {
	const { gw, gh, gx0, gy0 } = world;
	const gridMil = world.w.gridMil;
	const cellMargin = gridMil * 0.25;
	const swapNets = new Set<string>();
	for (const r of reqs)
		swapNets.add(r.net);
	for (const p of pads) {
		const cx = Math.round((p.x - gx0) / gridMil);
		const cy = Math.round((p.y - gy0) / gridMil);
		const rr = p.r + cellMargin;
		const span = Math.ceil(rr / gridMil);
		const tracked = p.net !== '' && swapNets.has(p.net);
		for (let dy = -span; dy <= span; dy++) {
			for (let dx = -span; dx <= span; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || y < 0 || x >= gw || y >= gh)
					continue;
				if (Math.hypot(dx * gridMil, dy * gridMil) >= rr)
					continue;
				for (let layer = 0; layer < 2; layer++) {
					const idx = (y * gw + x) * 2 + layer;
					world.block[idx] = 1;
					if (tracked)
						world.padNet.set(idx, p.net);
				}
			}
		}
	}
	for (const b of bodies) {
		const x0 = Math.max(0, Math.ceil((b.x0 - gx0) / gridMil));
		const y0 = Math.max(0, Math.ceil((b.y0 - gy0) / gridMil));
		const x1 = Math.min(gw - 1, Math.floor((b.x1 - gx0) / gridMil));
		const y1 = Math.min(gh - 1, Math.floor((b.y1 - gy0) / gridMil));
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				for (let layer = 0; layer < 2; layer++)
					world.block[(y * gw + x) * 2 + layer] = 1;
			}
		}
	}
}

/* ---------------- A* ---------------- */

/** 二叉最小堆（cost 升序） */
class MinHeap {
	private cost: Float64Array;
	private item: Int32Array;
	private n = 0;
	constructor(cap: number) {
		this.cost = new Float64Array(cap + 1);
		this.item = new Int32Array(cap + 1);
	}

	get size(): number {
		return this.n;
	}

	push(cost: number, item: number): void {
		if (this.n + 1 >= this.cost.length) {
			const nc = new Float64Array(this.cost.length * 2);
			nc.set(this.cost);
			this.cost = nc;
			const ni = new Int32Array(this.item.length * 2);
			ni.set(this.item);
			this.item = ni;
		}
		let i = ++this.n;
		this.cost[i] = cost;
		this.item[i] = item;
		while (i > 1) {
			const p = i >> 1;
			if (this.cost[p] <= this.cost[i])
				break;
			this.swap(p, i);
			i = p;
		}
	}

	pop(): { cost: number; item: number } | undefined {
		if (this.n === 0)
			return undefined;
		const cost = this.cost[1];
		const item = this.item[1];
		this.cost[1] = this.cost[this.n];
		this.item[1] = this.item[this.n];
		this.n--;
		let i = 1;
		for (;;) {
			const l = i << 1;
			let m = i;
			if (l <= this.n && this.cost[l] < this.cost[m])
				m = l;
			if (l + 1 <= this.n && this.cost[l + 1] < this.cost[m])
				m = l + 1;
			if (m === i)
				break;
			this.swap(m, i);
			i = m;
		}
		return { cost, item };
	}

	private swap(a: number, b: number): void {
		const c = this.cost[a];
		this.cost[a] = this.cost[b];
		this.cost[b] = c;
		const it = this.item[a];
		this.item[a] = this.item[b];
		this.item[b] = it;
	}
}

const encState = (cell: number, layer: number, dir: number) => (cell * 2 + layer) * 5 + dir;
const stateCell = (s: number) => Math.floor(s / 10);
const stateLayer = (s: number) => Math.floor(s / 5) % 2;
const stateDir = (s: number) => s % 5;

interface AStarBuffers {
	dist: Float64Array;
	prev: Int32Array;
}

function makeBuffers(world: World): AStarBuffers {
	const states = world.gw * world.gh * 2 * 5;
	return {
		dist: new Float64Array(states),
		prev: new Int32Array(states),
	};
}

/** 布一条网。成功返回路径并把占用写入 world（值 2）；失败返回 undefined（不占用） */
function routeOne(world: World, buf: AStarBuffers, req: RouteNetReq): RoutedPath | undefined {
	const { gw, gh, block, w } = world;
	const gridMil = w.gridMil;
	if (!req.targets.length)
		return undefined;
	const clampX = (x: number) => Math.max(0, Math.min(gw - 1, Math.round((x - world.gx0) / gridMil)));
	const clampY = (y: number) => Math.max(0, Math.min(gh - 1, Math.round((y - world.gy0) / gridMil)));
	const sx = clampX(req.from.x);
	const sy = clampY(req.from.y);
	// 目标格集合（格下标，不含层——任一层命中即可）
	const goalCells: number[] = [];
	const goalMark = new Uint8Array(gw * gh);
	for (const t of req.targets) {
		const tx = clampX(t.x);
		const ty = clampY(t.y);
		const c = ty * gw + tx;
		if (!goalMark[c]) {
			goalMark[c] = 1;
			goalCells.push(c);
		}
	}
	// 本网焊盘放行（含 from/target 邻域），布完恢复
	const released: number[] = [];
	for (const [idx, net] of world.padNet) {
		if (net === req.net && block[idx] === 1) {
			block[idx] = 0;
			released.push(idx);
		}
	}
	if (req.fromR && req.fromR > 0) {
		// 起点焊盘按坐标放行：虚拟指派下起点焊盘挂着原网络标签，按标签放行会挡住自己的出线
		const fr = req.fromR + gridMil * 0.25;
		const span = Math.ceil(fr / gridMil);
		for (let dy = -span; dy <= span; dy++) {
			for (let dx = -span; dx <= span; dx++) {
				const x = sx + dx;
				const y = sy + dy;
				if (x < 0 || y < 0 || x >= gw || y >= gh)
					continue;
				if (Math.hypot(dx * gridMil, dy * gridMil) >= fr)
					continue;
				for (let layer = 0; layer < 2; layer++) {
					const idx = (y * gw + x) * 2 + layer;
					if (block[idx] === 1) {
						block[idx] = 0;
						released.push(idx);
					}
				}
			}
		}
	}
	const escCode = req.fromEscape ? dirCode(req.fromEscape.dx, req.fromEscape.dy) : 0;
	// 启发值按格预算（到最近目标的曼哈顿下界）：压堆键=g+h，陈旧判定也用 g+h 对齐
	const hCell = new Float64Array(gw * gh);
	for (let y = 0; y < gh; y++) {
		for (let x = 0; x < gw; x++) {
			let h = Number.POSITIVE_INFINITY;
			for (const g of goalCells) {
				const gx = g % gw;
				const gy = Math.floor(g / gw);
				const hh = (Math.abs(gx - x) + Math.abs(gy - y)) * gridMil;
				if (hh < h)
					h = hh;
			}
			hCell[y * gw + x] = h;
		}
	}
	const dist = buf.dist;
	const prev = buf.prev;
	dist.fill(Number.POSITIVE_INFINITY);
	prev.fill(-1);
	const heap = new MinHeap(4096);
	const startCell = sy * gw + sx;
	for (let layer = 0; layer < 2; layer++) {
		// 底层起步视作在起点打过孔（引脚默认顶层出线）
		const s = encState(startCell, layer, 0);
		dist[s] = layer === 0 ? 0 : w.viaPenaltyMil;
		prev[s] = -1;
		heap.push(dist[s] + hCell[startCell], s);
	}
	let goalState = -1;
	while (heap.size > 0) {
		const top = heap.pop()!;
		const s = top.item;
		const cell = stateCell(s);
		if (top.cost > dist[s] + hCell[cell] + 1e-9)
			continue; // 陈旧堆项（键=g+h，对齐比较）
		if (goalMark[cell]) {
			goalState = s;
			break;
		}
		const layer = stateLayer(s);
		const dir = stateDir(s);
		const cx = cell % gw;
		const cy = Math.floor(cell / gw);
		const base = dist[s];
		// 出线约束：未移动（dir=0）且有约束方向时，第一步只允许沿约束方向
		const allowed = (code: number) => dir === 0 && escCode > 0 ? code === escCode : true;
		for (let d = 0; d < 4; d++) {
			if (!allowed(d + 1))
				continue;
			const nx = cx + DIRS[d].dx;
			const ny = cy + DIRS[d].dy;
			if (nx < 0 || ny < 0 || nx >= gw || ny >= gh)
				continue;
			const ncell = ny * gw + nx;
			if (block[ncell * 2 + layer] !== 0)
				continue;
			const bend = dir !== 0 && dir !== d + 1 ? w.bendPenaltyMil : 0;
			const cost = base + gridMil + bend;
			const ns = encState(ncell, layer, d + 1);
			if (cost < dist[ns] - 1e-9) {
				dist[ns] = cost;
				prev[ns] = s;
				heap.push(cost + hCell[ncell], ns);
			}
		}
		// 过孔：同格换层（两层都须可走）
		const otherLayer = 1 - layer;
		if (block[cell * 2 + otherLayer] === 0) {
			const cost = base + w.viaPenaltyMil;
			const ns = encState(cell, otherLayer, dir);
			if (cost < dist[ns] - 1e-9) {
				dist[ns] = cost;
				prev[ns] = s;
				heap.push(cost, ns);
			}
		}
	}
	for (const idx of released)
		block[idx] = world.padNet.has(idx) ? 1 : 0;
	if (goalState < 0)
		return undefined;
	// 回溯状态链
	const seq: number[] = [];
	for (let s = goalState; s >= 0; s = prev[s])
		seq.push(s);
	seq.reverse();
	const pts: RoutePt[] = [];
	let vias = 0;
	let lengthMil = 0;
	let lastCell = -1;
	let lastLayer = -1;
	for (const s of seq) {
		const cell = stateCell(s);
		const layer = stateLayer(s);
		if (cell !== lastCell) {
			if (lastCell >= 0)
				lengthMil += gridMil;
			pts.push({ x: world.gx0 + (cell % gw) * gridMil, y: world.gy0 + Math.floor(cell / gw) * gridMil });
			lastCell = cell;
		}
		if (layer !== lastLayer) {
			if (lastLayer >= 0)
				vias++;
			lastLayer = layer;
		}
	}
	// 占用：移动格挡所在层；过孔格挡两层（过孔桶）——焊盘格(1)保留为 max
	for (let i = 0; i < seq.length; i++) {
		const cell = stateCell(seq[i]);
		const layer = stateLayer(seq[i]);
		const viaHere = (i > 0 && stateLayer(seq[i - 1]) !== layer) || (i + 1 < seq.length && stateLayer(seq[i + 1]) !== layer);
		if (viaHere) {
			block[cell * 2] = Math.max(block[cell * 2], 2);
			block[cell * 2 + 1] = Math.max(block[cell * 2 + 1], 2);
		}
		else {
			block[cell * 2 + layer] = Math.max(block[cell * 2 + layer], 2);
		}
	}
	return { net: req.net, pts, vias, lengthMil: Math.round(lengthMil) };
}

/* ---------------- 占用撕除 ---------------- */

/** 撕除一条路径的占用（值 2 -> 0；登记过的焊盘格恢复 1） */
function unstampPath(world: World, path: RoutedPath): void {
	const { gw, gh, gx0, gy0 } = world;
	const gridMil = world.w.gridMil;
	const cellOf = (p: RoutePt) => ({
		x: Math.max(0, Math.min(gw - 1, Math.round((p.x - gx0) / gridMil))),
		y: Math.max(0, Math.min(gh - 1, Math.round((p.y - gy0) / gridMil))),
	});
	const clear = (x: number, y: number): void => {
		for (let layer = 0; layer < 2; layer++) {
			const idx = (y * gw + x) * 2 + layer;
			if (world.block[idx] === 2)
				world.block[idx] = world.padNet.has(idx) ? 1 : 0;
		}
	};
	if (path.pts.length < 2) {
		const c = cellOf(path.pts[0] ?? { x: gx0, y: gy0 });
		clear(c.x, c.y);
		return;
	}
	for (let i = 0; i + 1 < path.pts.length; i++) {
		const a = cellOf(path.pts[i]);
		const b = cellOf(path.pts[i + 1]);
		const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
		for (let s = 0; s <= steps; s++) {
			const t = steps === 0 ? 0 : s / steps;
			clear(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t));
		}
	}
}

/* ---------------- 布线会话（供求解器增量精修） ---------------- */

export interface SessionSnapshot {
	block: Uint8Array;
	paths: Map<string, RoutedPath | undefined>;
	/** 各网当前起点/出线方向（setFrom 的改动也要随快照回滚，否则被拒绝的试验会残留端点） */
	froms: Map<string, { from: RoutePt; escape?: { dx: number; dy: number } }>;
}

export interface RoutingSession {
	readonly summary: () => RoutingSummary;
	/** 当前全部路径快照（net -> 路径；undefined = 未布通） */
	readonly pathsSnapshot: () => Map<string, RoutedPath | undefined>;
	/** 初次顺序布线（短线优先；含未布通优先重排的重试轮） */
	routeInitial: () => void;
	/** 全量重布（按当前端点短线优先，消顺序伪影） */
	fullReroute: () => void;
	/** 撕掉并重布给定网络（原地提交） */
	rerouteNets: (nets: string[]) => void;
	/** 更新某网起点/出线方向（配合 rerouteNets 使用） */
	setFrom: (net: string, from: RoutePt, escape?: { dx: number; dy: number }) => void;
	snapshot: () => SessionSnapshot;
	restore: (snap: SessionSnapshot) => void;
}

export function createRoutingSession(
	reqsIn: RouteNetReq[],
	pads: RoutePad[],
	bodies: RouteRect[],
	w: RoutingWeights,
): RoutingSession | RoutingFallback {
	const reqs = reqsIn.filter(r => r.targets.length > 0);
	const worldOrFall = buildWorld(reqs, pads, bodies, w);
	if ('fellBack' in worldOrFall)
		return worldOrFall;
	const world = worldOrFall;
	const reqMap = new Map<string, RouteNetReq>();
	for (const r of reqs)
		reqMap.set(r.net, { ...r, targets: [...r.targets] });
	const paths = new Map<string, RoutedPath | undefined>();
	const buf = makeBuffers(world);
	const est = (r: RouteNetReq): number => {
		let best = Number.POSITIVE_INFINITY;
		for (const t of r.targets) {
			const d = Math.abs(t.x - r.from.x) + Math.abs(t.y - r.from.y);
			if (d < best)
				best = d;
		}
		return best;
	};
	const routeOrder = (nets: string[]): void => {
		for (const net of nets) {
			const old = paths.get(net);
			if (old)
				unstampPath(world, old);
			const r = reqMap.get(net);
			paths.set(net, r ? (routeOne(world, buf, r) ?? undefined) : undefined);
		}
	};
	const clearOccupancy = (): void => {
		for (let i = 0; i < world.block.length; i++) {
			if (world.block[i] === 2)
				world.block[i] = world.padNet.has(i) ? 1 : 0;
		}
	};
	const routeAllOrdered = (): void => {
		const order = [...reqMap.values()].sort((a, b) => est(a) - est(b)).map(r => r.net);
		routeOrder(order);
		// 重试轮：未布通的网优先重排（全撕重布，最多 3 轮）
		for (let round = 0; round < 3; round++) {
			const failed = order.filter(n => !paths.get(n));
			if (!failed.length)
				break;
			clearOccupancy();
			paths.clear();
			const rest = order.filter(n => !failed.includes(n));
			routeOrder([...failed, ...rest]);
		}
	};
	const session: RoutingSession = {
		pathsSnapshot: () => new Map(paths),
		summary: (): RoutingSummary => {
			let routed = 0;
			let unrouted = 0;
			let vias = 0;
			let lengthMil = 0;
			for (const p of paths.values()) {
				if (p) {
					routed++;
					vias += p.vias;
					lengthMil += p.lengthMil;
				}
				else {
					unrouted++;
				}
			}
			const score = unrouted * w.unroutedPenaltyMil + vias * w.viaPenaltyMil + lengthMil;
			return {
				routed,
				unrouted,
				vias,
				lengthMil: Math.round(lengthMil),
				score: Math.round(score),
				gridMil: world.w.gridMil,
				gridW: world.gw,
				gridH: world.gh,
			};
		},
		routeInitial: routeAllOrdered,
		fullReroute: routeAllOrdered,
		rerouteNets: (nets: string[]): void => {
			routeOrder(nets);
		},
		setFrom: (net: string, from: RoutePt, escape?: { dx: number; dy: number }): void => {
			const r = reqMap.get(net);
			if (r) {
				r.from = from;
				r.fromEscape = escape;
			}
		},
		snapshot: (): SessionSnapshot => {
			const pathCopy = new Map<string, RoutedPath | undefined>();
			for (const [k, v] of paths)
				pathCopy.set(k, v ? { ...v, pts: [...v.pts] } : undefined);
			const froms = new Map<string, { from: RoutePt; escape?: { dx: number; dy: number } }>();
			for (const [net, r] of reqMap)
				froms.set(net, { from: { ...r.from }, escape: r.fromEscape ? { ...r.fromEscape } : undefined });
			return { block: world.block.slice(), paths: pathCopy, froms };
		},
		restore: (snap: SessionSnapshot): void => {
			world.block.set(snap.block);
			paths.clear();
			for (const [k, v] of snap.paths)
				paths.set(k, v);
			for (const [net, f] of snap.froms) {
				const r = reqMap.get(net);
				if (r) {
					r.from = f.from;
					r.fromEscape = f.escape;
				}
			}
		},
	};
	return session;
}

/* ---------------- 指派代价估计（匈牙利初解用） ---------------- */

function crossSign(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
	return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** 线段与（外扩 eps 的）轴对齐矩形是否相交/触及 */
function segHitsRect(ax: number, ay: number, bx: number, by: number, r: RouteRect, eps: number): boolean {
	const x0 = r.x0 - eps;
	const y0 = r.y0 - eps;
	const x1 = r.x1 + eps;
	const y1 = r.y1 + eps;
	if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1)
		return true;
	if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1)
		return true;
	const cross = (px: number, py: number, qx: number, qy: number) => {
		const d1 = crossSign(px, py, qx, qy, ax, ay);
		const d2 = crossSign(px, py, qx, qy, bx, by);
		const d3 = crossSign(ax, ay, bx, by, px, py);
		const d4 = crossSign(ax, ay, bx, by, qx, qy);
		return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
	};
	return cross(x0, y0, x1, y0) || cross(x0, y1, x1, y1) || cross(x0, y0, x0, y1) || cross(x1, y0, x1, y1);
}

/**
 * 槽位焊盘 -> 网络最近端点的**绕行代价估计**（曼哈顿制）：
 * 直线（曼哈顿）不穿任何阻挡矩形则用直线；否则经阻挡矩形四角绕行取最短。
 * 相比欧氏直线，穿体指派被显著惩罚——四边出线器件的指派从初解起就避开穿体。
 */
export function estimateEscapeCost(from: RoutePt, targets: RoutePt[], bodies: RouteRect[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (const t of targets) {
		let cost = Math.abs(t.x - from.x) + Math.abs(t.y - from.y);
		for (const b of bodies) {
			if (segHitsRect(from.x, from.y, t.x, t.y, b, 1)) {
				let detour = Number.POSITIVE_INFINITY;
				for (const [cx, cy] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]] as const) {
					const d = Math.abs(cx - from.x) + Math.abs(cy - from.y) + Math.abs(t.x - cx) + Math.abs(t.y - cy);
					if (d < detour)
						detour = d;
				}
				cost = Math.max(cost, detour);
			}
		}
		if (cost < best)
			best = cost;
	}
	return Number.isFinite(best) ? best : 0;
}

/** 便捷一次性布线（不经会话） */
export function routeAll(reqs: RouteNetReq[], pads: RoutePad[], bodies: RouteRect[], w: RoutingWeights): RoutingResult | RoutingFallback {
	const s = createRoutingSession(reqs, pads, bodies, w);
	if ('fellBack' in s)
		return s;
	s.routeInitial();
	const sum = s.summary();
	return { ...sum, paths: [...s.pathsSnapshot().values()].filter((p): p is RoutedPath => !!p) };
}
