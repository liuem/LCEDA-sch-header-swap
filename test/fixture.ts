/**
 * 离线测试夹具 / Offline test fixture
 *
 * installEdaMock 在 globalThis.eda 上安装一个可编程的模拟 EDA 运行时，
 * 覆盖本插件用到的全部接口（原理图读取/写回、跨文档切换、PCB 读取/
 * 写回、对话框/进度/iframe），并记录调用序列供断言。
 * primMock 思路与 conn-export 相同：Proxy 把任意 getState_* 映射为
 * 取值函数。
 */

/** 任意图元的 getState_* 取值模拟（键不存在时方法也不存在，与真实客户端一致） */
export function primMock(getters: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
	return new Proxy({ ...extra }, {
		get(_t, prop: string) {
			if (prop in extra)
				return (extra as any)[prop];
			if (prop.startsWith('getState_')) {
				const key = prop.slice('getState_'.length);
				if (key in getters)
					return () => (getters as any)[key];
				return undefined;
			}
			return undefined;
		},
	});
}

export interface FixtureSchPin {
	id: string;
	pinNumber: string;
	pinName?: string;
	x: number;
	y: number;
	noConnect?: boolean;
}

export interface FixtureSchComp {
	id: string;
	designator: string;
	componentType?: string;
	pins: FixtureSchPin[];
}

export interface FixtureWire {
	id: string;
	/** flat [x1,y1,x2,y2,...] */
	line: number[];
	net?: string;
}

export interface FixtureNetFlag {
	id: string;
	net: string;
	x: number;
	y: number;
}

export interface FixturePcbPad {
	designator: string;
	padNumber: string;
	net: string;
	x: number;
	y: number;
	padId?: string;
}

export interface FixturePcbLine {
	net: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface FixtureOptions {
	selectedComps?: string[];
	selectedPins?: string[];
	/** PCB 选中的网络（pcb_SelectControl 返回带网络的图元） */
	selectedPcbNets?: string[];
	comps?: FixtureSchComp[];
	wires?: FixtureWire[];
	netFlags?: FixtureNetFlag[];
	/** sch_Net 权威网络名：[{ net, wires: [wireId] }] */
	projectNets?: Array<{ net: string; wires: string[] }>;
	pcbComps?: Array<{ id: string; designator: string }>;
	pcbPads?: FixturePcbPad[];
	pcbLines?: FixturePcbLine[];
	/** dmt_Project 工程信息形态 */
	projectInfo?: unknown;
	currentDoc?: { uuid: string; tabId?: string };
	/** 确认对话框的应答（默认 true） */
	confirmAnswer?: boolean;
	/** 指定导线 ID 的 modify 一律失败（注入删建回退路径） */
	failWireIds?: string[];
	/** 焊盘 modify 一律失败 */
	failPadModify?: boolean;
	/** 模拟 V3.2 实机：pad.getAll 图元无 getState_ParentComponentPrimitiveId（走器件引脚反查映射） */
	padsLackParent?: boolean;
	/** pcb 侧 getAllPinsByPrimitiveId 返回活引脚对象（setState_Net/done 真实生效） */
	livePins?: boolean;
	/** 模拟 V3.2 实机：sch 无参 getAll 抛「获取所有器件失败」，仅 ('part', true) 可用 */
	schGetAllArglessFails?: boolean;
	/** 模拟旧客户端：dmt_EditorControl 无 closeDocument（refreshPcbCanvas 走 ratline 退级） */
	noCloseDocument?: boolean;
}

export interface EdaMockResult {
	storage: Map<string, string>;
	calls: {
		wireModify: Array<{ id: string; net: string }>;
		wireCreate: Array<{ line: number[]; net: string }>;
		wireDelete: string[][];
		padModify: Array<{ padId: string; net: string }>;
		editor: string[];
		dialogs: Array<{ content: string; title: string }>;
		confirms: string[];
		toasts: string[];
		toastTypes: Array<unknown>;
		iframes: Array<{ html: string; id: string }>;
		pcbSave: number;
		ratlineRefresh: number;
		/** 原理图自动保存次数（同步/撤销的导线写路径） */
		schSave: number;
		/** 写画布前清空选中的次数（应用/撤销各一次） */
		selectionCleared: number;
		busChannels: string[];
		/** sch 器件 getAll 调用形态（"type:allPages"），守卫 V3.2 (part,true) 路径 */
		schGetAll: string[];
	};
	/** 发一条 MessageBus 消息（模拟预览窗口按钮） */
	pushBus: (channel: string, msg: string) => void;
	/** 读取当前模拟导线状态 */
	wireNet: (id: string) => string | undefined;
}

export function installEdaMock(opts: FixtureOptions = {}): EdaMockResult {
	const storage = new Map<string, string>();
	const calls: EdaMockResult['calls'] = {
		wireModify: [],
		wireCreate: [],
		wireDelete: [],
		padModify: [],
		editor: [],
		dialogs: [],
		confirms: [],
		toasts: [],
		toastTypes: [],
		iframes: [],
		pcbSave: 0,
		ratlineRefresh: 0,
		schSave: 0,
		selectionCleared: 0,
		busChannels: [],
		schGetAll: [],
	};
	const comps = opts.comps ?? [];
	const compById = new Map(comps.map(c => [c.id, c]));
	const wiresState = new Map<string, { line: number[]; net: string }>();
	for (const w of opts.wires ?? [])
		wiresState.set(w.id, { line: [...w.line], net: (w.net ?? '').trim() });
	const failWireIds = new Set(opts.failWireIds ?? []);
	const messageHandlers = new Map<string, (msg: unknown) => void>();

	const compPrim = (c: FixtureSchComp) => primMock(
		{ PrimitiveId: c.id, Designator: c.designator, ComponentType: c.componentType ?? 'part' },
		{ getState_PrimitiveType: () => 'Component' },
	);
	const pinPrim = (p: FixtureSchPin) => primMock(
		{ PrimitiveId: p.id, PinNumber: p.pinNumber, PinName: p.pinName ?? p.pinNumber, X: p.x, Y: p.y, NoConnected: p.noConnect === true },
		{ getState_PrimitiveType: () => 'ComponentPin' },
	);
	const wirePrim = (id: string) => {
		const w = wiresState.get(id)!;
		return primMock({ PrimitiveId: id, Line: [...w.line], Net: w.net });
	};

	const defaultProjectInfo = {
		data: [
			{ type: 'board', name: 'Board-1', schematic: { uuid: 'sch-uuid-1', pages: [{ uuid: 'sch-page-1' }] }, pcb: { uuid: 'pcb-uuid-1' } },
		],
	};

	const pcbCompByDesignator = new Map<string, string>();
	for (const [i, c] of (opts.pcbComps ?? []).entries())
		pcbCompByDesignator.set(c.designator, c.id ?? `pcbc-${i}`);
	const pcbDesByCompId = new Map<string, string>();
	for (const c of opts.pcbComps ?? [])
		pcbDesByCompId.set(c.id ?? `pcbc-${opts.pcbComps!.indexOf(c)}`, c.designator);

	let padSeq = 0;
	const padIdOf = (p: FixturePcbPad): string => p.padId ?? `pad-${p.designator}-${p.padNumber}-${padSeq++}`;
	// padsLackParent=true 模拟 V3.2 实机形态：pad.getAll 图元没有 parent 方法，
	// 位号须经器件 getAllPinsByPrimitiveId（返回带 PrimitiveId 的引脚）反向映射
	const pcbPadPrims = () => (opts.pcbPads ?? []).map((p) => {
		const getters: Record<string, unknown> = {
			PrimitiveId: padIdOf(p),
			Net: p.net,
			PadNumber: p.padNumber,
			X: p.x,
			Y: p.y,
		};
		if (!opts.padsLackParent)
			getters.ParentComponentPrimitiveId = pcbCompByDesignator.get(p.designator) ?? '';
		return primMock(getters);
	});

	const eda: any = {
		sys_Storage: {
			getExtensionUserConfig: (k: string) => (storage.has(k) ? storage.get(k) : undefined),
			setExtensionUserConfig: async (k: string, v: string) => {
				storage.set(k, String(v));
			},
		},
		sys_Dialog: {
			showInformationMessage: (content: string, title: string) => {
				calls.dialogs.push({ content, title });
			},
			showConfirmationMessage: (content: string, title: string, _yes: string, _no: string, cb: (main: boolean) => void) => {
				calls.confirms.push(content);
				cb(opts.confirmAnswer !== false);
			},
		},
		sys_ToastMessage: {
			showMessage: (m: unknown, t?: unknown) => {
				calls.toasts.push(String(m));
				calls.toastTypes.push(t);
			},
		},
		sys_IFrame: {
			openIFrame: async (html: string, _w: number, _h: number, id: string) => {
				calls.iframes.push({ html, id });
			},
			closeIFrame: async () => { /* ignore */ },
		},
		sys_LoadingAndProgressBar: { showProgressBar: () => { /* ignore */ }, destroyProgressBar: () => { /* ignore */ } },
		sys_MessageBus: {
			pull: (id: string, cb: (msg: unknown) => void) => {
				calls.busChannels.push(id);
				messageHandlers.set(id, cb);
			},
			push: (id: string, msg: unknown) => {
				messageHandlers.get(id)?.(msg);
			},
		},
		sch_SelectControl: {
			getAllSelectedPrimitives: async () => {
				const sel = new Set(opts.selectedComps ?? []);
				const selPins = new Set(opts.selectedPins ?? []);
				const out: any[] = [];
				for (const c of comps) {
					if (sel.has(c.designator))
						out.push(compPrim(c));
					for (const p of c.pins) {
						if (selPins.has(p.id))
							out.push(pinPrim(p));
					}
				}
				return out;
			},
		},
		sch_PrimitiveComponent: {
			getAll: async (type?: string, allPages?: boolean) => {
				if (type !== 'netflag')
					calls.schGetAll.push(`${type ?? '(none)'}:${allPages === true}`);
				if (type === 'netflag') {
					return (opts.netFlags ?? []).map(f => primMock(
						{ PrimitiveId: f.id, Net: f.net, X: f.x, Y: f.y },
						{ getState_PrimitiveType: () => 'Component' },
					));
				}
				if (!type && opts.schGetAllArglessFails)
					throw new Error('获取所有器件失败');
				return comps.map(compPrim);
			},
			getAllPinsByPrimitiveId: async (id: string) => (compById.get(id)?.pins ?? []).map(pinPrim),
			delete: async (_ids: string[]) => true,
		},
		sch_PrimitiveWire: {
			getAll: async () => [...wiresState.keys()].map(wirePrim),
			get: async (ids: string[]) => ids.map(id => (wiresState.has(id) ? wirePrim(id) : undefined)),
			create: async (line: number[], net: string) => {
				calls.wireCreate.push({ line: [...line], net });
				const id = `w-new-${calls.wireCreate.length}`;
				wiresState.set(id, { line: [...line], net });
				return wirePrim(id);
			},
			modify: async (id: string, props: { net?: string }) => {
				const key = typeof id === 'string' ? id : String(id?.getState_PrimitiveId?.() ?? id);
				const w = wiresState.get(key);
				if (!w)
					return false;
				if (failWireIds.has(key))
					return false;
				if (typeof props?.net === 'string') {
					w.net = props.net;
					calls.wireModify.push({ id: key, net: props.net });
				}
				return wirePrim(key);
			},
			delete: async (ids: string[]) => {
				calls.wireDelete.push([...ids]);
				for (const id of ids)
					wiresState.delete(id);
				return true;
			},
		},
		sch_Net: {
			getCurrentProjectAllNets: async () => {
				if (!opts.projectNets)
					return [];
				return [{
					nets: opts.projectNets.map(n => ({
						net: n.net,
						wires: n.wires.map(id => ({ id })),
					})),
				}];
			},
		},
		dmt_Project: {
			getCurrentProjectInfo: async () => opts.projectInfo ?? defaultProjectInfo,
		},
		dmt_SelectControl: {
			getCurrentDocumentInfo: async () => opts.currentDoc ?? { uuid: 'pcb-uuid-1', tabId: 'tab-pcb-uuid-1' },
		},
		dmt_EditorControl: {
			openDocument: async (uuid: string) => {
				calls.editor.push(`open:${uuid}`);
				return { tabId: `tab-${uuid}` };
			},
			activateDocument: async (t: { tabId?: string } | string) => {
				calls.editor.push(`activate:${typeof t === 'string' ? t : t?.tabId ?? '?'}`);
			},
			...(opts.noCloseDocument
				? {}
				: {
						closeDocument: async (t: string | { tabId?: string }) => {
							calls.editor.push(`close:${typeof t === 'string' ? t : t?.tabId ?? '?'}`);
							return true;
						},
					}),
		},
		pcb_SelectControl: {
			getAllSelectedPrimitives: async () => (opts.selectedPcbNets ?? []).map(net => primMock({ Net: net })),
			clearSelected: async () => {
				calls.selectionCleared++;
			},
		},
		pcb_PrimitiveComponent: {
			getAll: async () => (opts.pcbComps ?? []).map(c => primMock({ PrimitiveId: c.id, Designator: c.designator })),
			// V3.2 形态下焊盘位号映射的来源：器件引脚（带 PrimitiveId = 焊盘 ID）。
			// livePins=true 时返回"活引脚"对象（setState_Net/done 可真实改网络并记录），
			// 供生产 createPcbHooks 的 setState 主路径做端到端测试
			getAllPinsByPrimitiveId: async (id: string) => {
				const des = pcbDesByCompId.get(String(id));
				const pads = (opts.pcbPads ?? []).filter(p => p.designator === des && p.padId);
				if (opts.livePins) {
					return pads.map((p) => {
						return {
							getState_PrimitiveId: () => p.padId,
							getState_PadNumber: () => p.padNumber,
							getState_Net: () => p.net,
							getState_X: () => p.x,
							getState_Y: () => p.y,
							setState_Net: (n: string) => {
								p.net = n;
								calls.padModify.push({ padId: p.padId!, net: n });
							},
							done: () => true,
						};
					});
				}
				return pads.map(p => primMock({ PrimitiveId: p.padId, Net: p.net, PadNumber: p.padNumber, X: p.x, Y: p.y }));
			},
		},
		pcb_PrimitivePad: {
			getAll: async () => pcbPadPrims(),
			modify: async (id: string, props: { net?: string }) => {
				if (opts.failPadModify)
					return false;
				calls.padModify.push({ padId: id, net: props?.net ?? '' });
				return primMock({ PrimitiveId: id, Net: props?.net ?? '' });
			},
		},
		pcb_PrimitiveLine: {
			getAll: async () => (opts.pcbLines ?? []).map(l => primMock(
				{ Net: l.net, StartX: l.x1, StartY: l.y1, EndX: l.x2, EndY: l.y2 },
			)),
		},
		sch_Document: {
			save: async () => {
				calls.schSave++;
				return true;
			},
		},
		pcb_Document: {
			save: async () => {
				calls.pcbSave++;
				return true;
			},
			startCalculatingRatline: async () => {
				calls.ratlineRefresh++;
			},
		},
	};

	(globalThis as any).eda = eda;

	return {
		storage,
		calls,
		pushBus: (channel, msg) => eda.sys_MessageBus.push(channel, msg),
		wireNet: id => wiresState.get(id)?.net,
	};
}
