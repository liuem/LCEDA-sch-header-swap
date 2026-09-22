/**
 * 类型定义 / Shared types
 *
 * 坐标单位约定：
 * - 原理图画布 1 单位 = 0.01 英寸 = 10mil（与 net-fanout/conn-export 一致）
 * - PCB 画布为 mil，焊盘 getState_X/Y 已含器件旋转的绝对坐标
 */

/** 原理图引脚 */
export interface SchPin {
	pinNumber: string;
	pinName: string;
	x: number;
	y: number;
	noConnect: boolean;
}

/** 选中的排插/连接器（原理图侧，普通器件 'part'） */
export interface SchHeader {
	primitiveId: string;
	designator: string;
	pins: SchPin[];
}

/** PCB 焊盘（全板扁平视图，mil） */
export interface Pad {
	/** 所属器件位号（如 J1 / U5） */
	designator: string;
	padNumber: string;
	/** 网络名，空串 = 无网络 */
	net: string;
	x: number;
	y: number;
	/** PCB 焊盘图元 ID（同步 PCB 时 modify 用） */
	padId?: string;
}

/** 鼠线几何指标（按焊盘坐标 MST 估算） */
export interface RatsnestMetrics {
	totalLengthMil: number;
	crossings: number;
}

/** 引脚不参与交换的原因 */
export type PinLockReason
	= | 'locked-user' // 用户锁定名单
		| 'power' // 电源/地网络名单（含裸电压形态）
		| 'no-net' // 无网络
		| 'no-sch-pin' // 原理图引脚缺失
		| 'no-pcb-pad' // PCB 侧找不到对应焊盘
		| 'duplicate-net' // 同一网络在本排插出现多次
		| 'sch-no-stub' // 原理图侧引脚未连任何导线
		| 'sch-shared' // 连通簇内还有其它器件引脚（汇入结点/总线）
		| 'sch-netflag' // 网络由电源符号承载（建议改为导线网络名）
		| 'net-mismatch'; // 原理图簇网络名与 PCB 焊盘网络名不一致

/** 引脚的原理图侧网络载体（改写目标） */
export interface StubTarget {
	/** 承载导线图元 ID（net 属性改写目标） */
	wireIds: string[];
	/** 导线原始折线（flat [x1,y1,...]），删建回退用 */
	wireLines: Array<{ id: string; line: number[] }>;
	/** 簇内导线自带的网络名（去重，不含权威名兜底） */
	labelNets: string[];
}

/** 单个排插引脚的重排规划 */
export interface HeaderPinPlan {
	pinNumber: string;
	pinName: string;
	/** PCB 焊盘当前网络（交换的"旧网络"） */
	oldNet: string;
	/** 求解后的"新网络"；不可换脚 = oldNet */
	newNet: string;
	swappable: boolean;
	lockReason?: PinLockReason;
	/** PCB 焊盘（坐标/ID），无对应焊盘时缺省 */
	pad?: Pad;
	/** 原理图侧载体（仅可换脚有） */
	stub?: StubTarget;
}

/** 优化目标权重档 */
export type WeightMode = 'crossings' | 'balanced' | 'length';

export interface HeaderSwapConfig {
	/** 锁定引脚名单：逗号/分号/空白分隔，条目 "位号.引脚号"（如 J1.1）或纯引脚号（作用于全部候选器件） */
	lockPins: string;
	/** 电源/地网络通配名单（逗号/分号/空白分隔，* 通配，另自动识别 3V3/1V8 等裸电压形态） */
	powerPatterns: string;
	/** 目标函数权重档：偏重交叉 / 均衡 / 偏重线长 */
	weightMode: WeightMode;
	/** 2-opt 精修轮数上限（每轮遍历全部交换对） */
	maxRefineIters: number;
	/** 写画布的起步间隔毫秒（失败自适应翻倍，画布限流经验值） */
	createIntervalMs: number;
	/** 单项写操作的最大重试次数 */
	maxRetries: number;
}

export const DEFAULT_CONFIG: HeaderSwapConfig = {
	lockPins: '',
	powerPatterns: 'GND*,AGND,DGND,PGND,VCC,VEE,VDD*,VSS*,VBAT,VBUS,VIN,VREF,VDDA,VSSA,AVDD,AVSS,EP,GND,PWR',
	weightMode: 'balanced',
	maxRefineIters: 4,
	createIntervalMs: 100,
	maxRetries: 3,
};

/** 一次完整重排方案（单个器件），deviceDesignator = 实施交换的器件（排插/MCU/FPGA 均可） */
export interface SwapPlan {
	headerDesignator: string;
	pins: HeaderPinPlan[];
	metricsBefore: RatsnestMetrics;
	metricsAfter: RatsnestMetrics;
	/** 发生交换的引脚数 */
	changedCount: number;
	swappableCount: number;
}

/**
 * 预览报告（可含多个候选器件），存 sys_Storage 供 iframe 与「应用」命令共用。
 * 主场在 PCB：应用 = 改焊盘网络（画布鼠线即预览），原理图事后经「同步」跟进。
 */
export interface SwapReport {
	generatedAt: string;
	/** 参与交换的 PCB 网络（用户选中） */
	selectedNets: string[];
	/** 各候选器件的方案 */
	plans: SwapPlan[];
	/** 应用后记录所选器件（后续同步原理图用） */
	chosenDevice?: string;
	/** 已应用到 PCB */
	appliedPcb?: boolean;
	/** 已同步到原理图 */
	schSynced?: boolean;
	/** PCB 上下文（撤销时重新激活） */
	pcb?: { uuid: string; tabId?: string; label: string };
	/** 受影响网络已有走线（mil），应用前的守卫数据 */
	routedLengthMil: Record<string, number>;
	notes: string[];
}
