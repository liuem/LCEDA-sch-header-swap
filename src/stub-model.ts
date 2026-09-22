/**
 * 原理图侧连接形态分类与重排方案组装 / Stub classification & plan assembly
 *
 * 换网络 = 改排插引脚所连导线的 net 属性。为防止改坏共享网络，必须先
 * 判定每个引脚的"承载形态"：只有引脚独占的孤立导线簇（簇内除本引脚外
 * 无任何器件引脚、无电源符号、网络名唯一）才允许改写；其余一律锁定并
 * 给出原因。簇分析复用 conn-export 的几何口径（并查集 + 端点命中）。
 */
import type { HeaderPinPlan, HeaderSwapConfig, Pad, PinLockReason, SchHeader, StubTarget } from './types.ts';
import { pointOnSegment } from './geometry.ts';

/** 当前页导线（ownNet=导线自带网络名，authNet=sch_Net 权威名） */
export interface PageWire {
	id: string;
	/** flat [x1,y1,...]（删建回退重建导线用） */
	line: number[];
	vertices: Array<{ x: number; y: number }>;
	ownNet: string;
	authNet: string;
}

/** 当前页电源/地符号（netflag 是 Component 图元） */
export interface PageNetFlag {
	id: string;
	net: string;
	x: number;
	y: number;
}

/** 当前页任意器件引脚（簇成员判定用） */
export interface PagePinRef {
	designator: string;
	pinNumber: string;
	x: number;
	y: number;
}

export interface PinClass {
	/** 独占导线簇（可换脚的改写载体） */
	stub?: StubTarget;
	/** 不可换原因（无 stub 时必有） */
	reason?: PinLockReason;
}

/** 裸电压形态网络名：3V3 / 1V8 / +5V / 2V5 / 5V 等 */
export function isBareVoltage(net: string): boolean {
	return /^[+-]?\d+(?:\.\d+)?V\d*$/i.test(net.trim());
}

/** 电源网络匹配器：通配名单（* 通配，忽略大小写整词匹配）+ 裸电压形态 */
export function makePowerMatcher(patterns: string): (net: string) => boolean {
	const list = String(patterns ?? '')
		.split(/[,;\s]+/)
		.map(s => s.trim())
		.filter(Boolean);
	const regexps = list.map((p) => {
		const re = p.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
		return new RegExp(`^${re}$`, 'i');
	});
	return (net: string) => {
		const n = net.trim();
		if (!n)
			return false;
		return regexps.some(re => re.test(n)) || isBareVoltage(n);
	};
}

/** 用户锁定名单："J1.1,J1.3" 或纯引脚号 "1 3"（作用于全部选中排插） */
export function parseLockPins(spec: string): { exact: Set<string>; bare: Set<string> } {
	const exact = new Set<string>();
	const bare = new Set<string>();
	for (const raw of String(spec ?? '').split(/[,;\s]+/)) {
		const item = raw.trim();
		if (!item)
			continue;
		if (item.includes('.')) {
			const [des, pin] = item.split('.', 2);
			if (des.trim() && pin.trim())
				exact.add(`${des.trim().toUpperCase()}.${pin.trim()}`);
		}
		else {
			bare.add(item);
		}
	}
	return { exact, bare };
}

/** 简单并查集（按导线 ID，共享顶点即连通——conn-export 口径） */
class WireUnion {
	private parent = new Map<string, string>();

	find(k: string): string {
		let root = k;
		while (this.parent.get(root) !== root)
			root = this.parent.get(root) ?? root;
		let cur = k;
		while (this.parent.get(cur) !== cur) {
			const next = this.parent.get(cur)!;
			this.parent.set(cur, root);
			cur = next;
		}
		this.parent.set(k, root);
		return root;
	}

	union(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb)
			this.parent.set(ra, rb);
	}

	ensure(k: string): void {
		if (!this.parent.has(k))
			this.parent.set(k, k);
	}
}

const coordKey = (x: number, y: number): string => `${Math.round(x)}\u0001${Math.round(y)}`;

/**
 * 分析当前页连接形态：返回排插每个引脚号 -> 独占簇载体或锁定原因。
 * 只看几何（导线顶点共享 + 引脚/符号落线命中），不读网表。
 */
export function classifyHeaderPins(header: SchHeader, wires: PageWire[], netflags: PageNetFlag[], pagePins: PagePinRef[]): Map<string, PinClass> {
	// 1. 导线按共享顶点连通
	const uf = new WireUnion();
	const byVertex = new Map<string, string>(); // coordKey -> 首个导线 ID
	for (const w of wires) {
		uf.ensure(w.id);
		for (const v of w.vertices) {
			const key = coordKey(v.x, v.y);
			const first = byVertex.get(key);
			if (first && first !== w.id)
				uf.union(first, w.id);
			else if (!first)
				byVertex.set(key, w.id);
		}
	}

	// 2. 引脚 / 电源符号按"落线命中"归入导线簇
	const clusterPins = new Map<string, PagePinRef[]>();
	const clusterFlags = new Map<string, PageNetFlag[]>();
	const hitWires = (x: number, y: number): string[] => {
		const hits: string[] = [];
		for (const w of wires) {
			const vs = w.vertices;
			for (let i = 0; i + 1 < vs.length; i++) {
				if (pointOnSegment(x, y, vs[i].x, vs[i].y, vs[i + 1].x, vs[i + 1].y)) {
					hits.push(w.id);
					break;
				}
			}
		}
		return hits;
	};
	for (const pin of pagePins) {
		for (const wid of hitWires(pin.x, pin.y)) {
			const root = uf.find(wid);
			const list = clusterPins.get(root) ?? [];
			list.push(pin);
			clusterPins.set(root, list);
		}
	}
	for (const flag of netflags) {
		for (const wid of hitWires(flag.x, flag.y)) {
			const root = uf.find(wid);
			const list = clusterFlags.get(root) ?? [];
			list.push(flag);
			clusterFlags.set(root, list);
		}
	}

	// 3. 逐引脚分类
	const result = new Map<string, PinClass>();
	for (const pin of header.pins) {
		const hits = hitWires(pin.x, pin.y);
		if (!hits.length) {
			result.set(pin.pinNumber, { reason: 'sch-no-stub' });
			continue;
		}
		const roots = [...new Set(hits.map(h => uf.find(h)))];
		// 簇内除本引脚外是否还有任何器件引脚（含本排插其它引脚）
		let shared = false;
		for (const root of roots) {
			for (const other of clusterPins.get(root) ?? []) {
				if (!(other.designator === header.designator && other.pinNumber === pin.pinNumber)) {
					shared = true;
					break;
				}
			}
			if (shared)
				break;
		}
		if (shared) {
			result.set(pin.pinNumber, { reason: 'sch-shared' });
			continue;
		}
		// 簇内有电源/地符号：网络由符号承载，改名语义易错，锁定
		if (roots.some(root => (clusterFlags.get(root) ?? []).length > 0)) {
			result.set(pin.pinNumber, { reason: 'sch-netflag' });
			continue;
		}
		const clusterWires = wires.filter(w => roots.includes(uf.find(w.id)));
		const labelNets = [...new Set(clusterWires.flatMap(w => [w.ownNet, w.authNet].filter(n => n && n.trim())))];
		const stub: StubTarget = {
			wireIds: clusterWires.map(w => w.id),
			wireLines: clusterWires.map(w => ({ id: w.id, line: w.line })),
			labelNets,
		};
		if (labelNets.length > 1) {
			// 孤立簇却带两个网络名：命名冲突，保守锁定
			result.set(pin.pinNumber, { reason: 'net-mismatch', stub });
			continue;
		}
		result.set(pin.pinNumber, { stub });
	}
	return result;
}

/**
 * 组装单排插的引脚规划（不求解）：合并 PCB 焊盘匹配、用户锁定、电源
 * 名单、重复网络与原理图形态分类，产出每个引脚的 newNet（先=oldNet）。
 */
export function buildPinPlans(
	header: SchHeader,
	boardPads: Pad[],
	wires: PageWire[],
	netflags: PageNetFlag[],
	pagePins: PagePinRef[],
	cfg: HeaderSwapConfig,
): HeaderPinPlan[] {
	const classes = classifyHeaderPins(header, wires, netflags, pagePins);
	const isPower = makePowerMatcher(cfg.powerPatterns);
	const locks = parseLockPins(cfg.lockPins);

	// 位号.引脚号 -> 焊盘（同排插焊盘号唯一；比较去空格，数字字符串比对）
	const padByPin = new Map<string, Pad>();
	for (const p of boardPads) {
		if (p.designator !== header.designator)
			continue;
		padByPin.set(p.padNumber.trim(), p);
	}

	interface Draft extends HeaderPinPlan {
		userLocked: boolean;
	}

	const drafts: Draft[] = header.pins.map((pin) => {
		const pad = padByPin.get(pin.pinNumber.trim());
		const oldNet = (pad?.net ?? '').trim();
		const cls = classes.get(pin.pinNumber) ?? { reason: 'sch-no-stub' as PinLockReason };
		const userLocked = locks.exact.has(`${header.designator.toUpperCase()}.${pin.pinNumber.trim()}`)
			|| locks.bare.has(String(pin.pinNumber).trim());
		return {
			pinNumber: pin.pinNumber,
			pinName: pin.pinName,
			oldNet,
			newNet: oldNet,
			swappable: false,
			lockReason: undefined,
			pad,
			stub: cls.stub,
			userLocked,
			...(cls.reason && !cls.stub ? { lockReason: cls.reason } : {}),
		};
	});

	// 规则链：无引脚/无焊盘/无网络/NoERC -> 用户锁定 -> 电源 -> 原理图形态 -> 网络名一致性 -> 重复网络
	for (const d of drafts) {
		if (!d.pad)
			d.lockReason = 'no-pcb-pad';
		else if (!d.oldNet || header.pins.find(p => p.pinNumber === d.pinNumber)?.noConnect)
			d.lockReason = 'no-net';
		else if (d.userLocked)
			d.lockReason = 'locked-user';
		else if (isPower(d.oldNet))
			d.lockReason = 'power';
		else if (d.lockReason)
			continue; // 分类器给出的形态原因（sch-no-stub/sch-shared/sch-netflag）
		else if (!d.stub)
			d.lockReason = 'sch-no-stub';
		else if (d.stub.labelNets.length !== 1 || d.stub.labelNets[0] !== d.oldNet)
			d.lockReason = 'net-mismatch';
	}

	// 同一网络出现在多个可换脚：全部锁定（v1 不做多重集指派）
	const netCount = new Map<string, number>();
	for (const d of drafts) {
		if (!d.lockReason && d.oldNet)
			netCount.set(d.oldNet, (netCount.get(d.oldNet) ?? 0) + 1);
	}
	for (const d of drafts) {
		if (!d.lockReason && (netCount.get(d.oldNet) ?? 0) > 1)
			d.lockReason = 'duplicate-net';
	}

	return drafts.map(({ userLocked: _userLocked, ...plan }) => {
		plan.swappable = !plan.lockReason;
		return plan;
	});
}

/**
 * PCB 阶段方案组装：给定器件与选中的网络集合，把该器件落在选中网络上的
 * 焊盘整理成待求解的引脚规划（不做原理图形态判定——那是同步原理图时的事）。
 * 锁定规则：用户名单 → 电源名单 → 重复网络；pinNumber = 焊盘号。
 */
export function buildDevicePinsPlan(
	deviceDesignator: string,
	boardPads: Pad[],
	selectedNets: ReadonlySet<string>,
	cfg: HeaderSwapConfig,
): HeaderPinPlan[] {
	const isPower = makePowerMatcher(cfg.powerPatterns);
	const locks = parseLockPins(cfg.lockPins);
	const drafts = boardPads
		.filter(p => p.designator === deviceDesignator && selectedNets.has(p.net.trim()))
		.map((p) => {
			const pin = p.padNumber.trim();
			const userLocked = locks.exact.has(`${deviceDesignator.toUpperCase()}.${pin}`) || locks.bare.has(pin);
			return {
				pinNumber: pin,
				pinName: pin,
				oldNet: p.net.trim(),
				newNet: p.net.trim(),
				swappable: false,
				lockReason: undefined as PinLockReason | undefined,
				pad: p,
				userLocked,
			};
		});
	for (const d of drafts) {
		if (d.userLocked)
			d.lockReason = 'locked-user';
		else if (isPower(d.oldNet))
			d.lockReason = 'power';
	}
	const netCount = new Map<string, number>();
	for (const d of drafts) {
		if (!d.lockReason)
			netCount.set(d.oldNet, (netCount.get(d.oldNet) ?? 0) + 1);
	}
	for (const d of drafts) {
		if (!d.lockReason && (netCount.get(d.oldNet) ?? 0) > 1)
			d.lockReason = 'duplicate-net';
	}
	return drafts.map(({ userLocked: _userLocked, ...plan }) => {
		plan.swappable = !plan.lockReason;
		return plan;
	});
}
