const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

/**
 * 构建产物冒烟测试 / Bundle smoke test
 *
 * 用 mock 的全局 eda 驱动 dist/index.js 的 runNetSwap / applyNetSwapDevice /
 * syncLastSwapToSch / undoLastSwap / openSettingsPanel / about，验证扩展真实
 * 入口的完整流程（读选中网络 -> 全板求解 -> 报告缓存 -> 预览窗口 -> 改 PCB
 * 焊盘 -> 同步原理图 -> 撤销 -> 错误路径），全程不调用文件系统/联网接口。
 * 用法：npm run build 后 node test/smoke-bundle.cjs
 */

function primMock(getters, extra = {}) {
	return new Proxy({ ...extra }, {
		get(_t, prop) {
			if (typeof prop === 'string' && prop in extra)
				return extra[prop];
			if (typeof prop === 'string' && prop.startsWith('getState_')) {
				const key = prop.replace('getState_', '');
				return () => getters[key];
			}
			return undefined;
		},
	});
}

const storage = new Map();
const dialogs = [];
const iframes = [];
const busChannels = [];
const editorCalls = [];
const padModify = [];
let pcbSave = 0;
let ratlineRefresh = 0;

// ---- 镜像工程：J1 焊盘 1..6 (2000,100i) 挂 IO1..IO6；U2 焊盘 (3000,700-100j) 互为镜像 ----
// 原理图页：U2 引脚 Paj (900,700-100j) 各带独占导线挂 IOj；IO3 有走线
const j1Pins = Array.from({ length: 8 }, (_, i) => ({ id: `sp${i + 1}`, number: String(i + 1), name: `P${i + 1}`, x: 100, y: 100 * (i + 1) }));
const u2Pins = Array.from({ length: 6 }, (_, i) => ({ id: `up${i + 1}`, number: `PA${i + 1}`, name: `PA${i + 1}`, x: 900, y: 700 - 100 * (i + 1) }));
const COMPS = [
	{ id: 'comp-J1', designator: 'J1', pins: j1Pins },
	{ id: 'comp-U2', designator: 'U2', pins: u2Pins },
];
const wiresState = new Map();
const projectNets = [];
for (let j = 1; j <= 6; j++) {
	const y = 700 - 100 * j;
	wiresState.set(`uw${j}`, { line: [900, y, 850, y], net: `IO${j}` });
	projectNets.push({ net: `IO${j}`, wires: [{ id: `uw${j}` }] });
}
const wirePrim = id => primMock({ PrimitiveId: id, Line: [...wiresState.get(id).line], Net: wiresState.get(id).net });
const pcbPads = [];
for (let i = 1; i <= 8; i++)
	pcbPads.push({ padId: `pad-J1-${i}`, des: 'J1', num: String(i), net: i <= 6 ? `IO${i}` : 'GND', x: 2000, y: 100 * i });
for (let j = 1; j <= 6; j++)
	pcbPads.push({ padId: `pad-U2-${j}`, des: 'U2', num: `PA${j}`, net: `IO${j}`, x: 3000, y: 700 - 100 * j });
pcbPads.push({ padId: 'pad-U2-G', des: 'U2', num: 'GND', net: 'GND', x: 3000, y: 850 });

globalThis.eda = {
	sys_Dialog: {
		showConfirmationMessage(content, _title, _ok, _cancel, cb) {
			dialogs.push(`confirm: ${content}`);
			cb(true);
		},
		showInformationMessage(content, title) { dialogs.push(`${title}: ${content}`); },
	},
	sys_ToastMessage: { showMessage(msg) { dialogs.push(`toast: ${msg}`); } },
	sys_LoadingAndProgressBar: { showProgressBar() {}, destroyProgressBar() {} },
	sys_IFrame: {
		async openIFrame(url, _w, _h, id) {
			iframes.push({ url, id });
		},
	},
	sys_Storage: {
		getExtensionUserConfig: k => (storage.has(k) ? storage.get(k) : undefined),
		setExtensionUserConfig: async (k, v) => { storage.set(k, String(v)); },
	},
	sys_MessageBus: {
		pull(id, cb) {
			busChannels.push(id);
			globalThis.__busHandler = cb;
		},
		push(id, msg) { globalThis.__busHandler?.(msg); },
	},
	pcb_SelectControl: {
		async getAllSelectedPrimitives() {
			return ['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6'].map(net => primMock({ Net: net }));
		},
	},
	sch_SelectControl: { async getAllSelectedPrimitives() { return []; } },
	sch_PrimitiveComponent: {
		async getAll(type) {
			if (type === 'netflag')
				return [];
			return COMPS.map(c => primMock({ PrimitiveType: 'Component', ComponentType: 'part', Designator: c.designator, PrimitiveId: c.id }));
		},
		async getAllPinsByPrimitiveId(id) {
			const c = COMPS.find(x => x.id === id);
			return (c?.pins ?? []).map(p => primMock({ PrimitiveType: 'ComponentPin', PrimitiveId: p.id, PinNumber: p.number, PinName: p.name, X: p.x, Y: p.y, NoConnected: false }));
		},
	},
	sch_PrimitiveWire: {
		async getAll() { return [...wiresState.keys()].map(wirePrim); },
		async get(ids) { return ids.map(id => (wiresState.has(id) ? wirePrim(id) : undefined)); },
		async create(line, net) {
			const id = `w-new-${wiresState.size + 1}`;
			wiresState.set(id, { line: [...line], net });
			return wirePrim(id);
		},
		async modify(id, props) {
			const w = wiresState.get(id);
			if (!w)
				return false;
			if (typeof props?.net === 'string')
				w.net = props.net;
			return wirePrim(id);
		},
		async delete(ids) {
			ids.forEach(i => wiresState.delete(i));
			return true;
		},
	},
	sch_Net: { async getCurrentProjectAllNets() { return [{ nets: projectNets }]; } },
	dmt_Project: {
		async getCurrentProjectInfo() {
			return { data: [{ type: 'board', name: 'SmokeBoard', schematic: { uuid: 'sch-1', pages: [{ uuid: 'sch-page-1' }] }, pcb: { uuid: 'pcb-1' } }] };
		},
	},
	dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'pcb-1', tabId: 'tab-pcb' }; } },
	dmt_EditorControl: {
		async openDocument(uuid) {
			editorCalls.push(`open:${uuid}`);
			return { tabId: `tab-${uuid}` };
		},
		async activateDocument(t) { editorCalls.push(`activate:${typeof t === 'string' ? t : t?.tabId}`); },
	},
	pcb_PrimitiveComponent: {
		getAll() { return [primMock({ PrimitiveId: 'pc-J1', Designator: 'J1' }), primMock({ PrimitiveId: 'pc-U2', Designator: 'U2' })]; },
		async getAllPinsByPrimitiveId(id) {
			const des = id === 'pc-J1' ? 'J1' : 'U2';
			return pcbPads.filter(p => p.des === des).map(p => primMock({ PrimitiveId: p.padId, Net: p.net, PadNumber: p.num, X: p.x, Y: p.y }));
		},
	},
	pcb_PrimitivePad: {
		async getAll() {
			return pcbPads.map(p => primMock({ PrimitiveId: p.padId, Net: p.net, PadNumber: p.num, X: p.x, Y: p.y, ParentComponentPrimitiveId: `pc-${p.des}` }));
		},
		async modify(id, props) {
			padModify.push({ padId: id, net: props?.net });
			return primMock({ PrimitiveId: id, Net: props?.net });
		},
	},
	pcb_PrimitiveLine: {
		async getAll() { return [primMock({ Net: 'IO3', StartX: 0, StartY: 0, EndX: 500, EndY: 0 })]; },
	},
	pcb_Document: {
		async save() {
			pcbSave++;
			return true;
		},
		async startCalculatingRatline() { ratlineRefresh++; },
	},
};

// bundle 以 `var edaEsbuildExportName = (()=>{...})()` 暴露（EDA 运行时求值读取），
// CommonJS require 拿不到模块作用域变量，这里显式求值捕获
const bundleSrc = fs.readFileSync(path.join(__dirname, '../dist/index.js'), 'utf8');
// 求值捕获是唯一手段（EDA 运行时同样以求值方式读取该变量），故豁免 no-new-func
// eslint-disable-next-line no-new-func
const api = new Function(`${bundleSrc}; return edaEsbuildExportName;`)();
if (!api)
	throw new Error('bundle 未导出 edaEsbuildExportName');
for (const fn of ['runNetSwap', 'applyNetSwapDevice', 'syncLastSwapToSch', 'undoLastSwap', 'openSettingsPanel', 'about']) {
	if (typeof api[fn] !== 'function')
		throw new Error(`缺少导出函数 ${fn}`);
}

let failures = 0;
const checks = [];
function ok(cond, label) {
	checks.push(`${cond ? '✓' : '✗'} ${label}`);
	if (!cond)
		failures++;
}

const wireNet = id => wiresState.get(id)?.net;

(async () => {
	// 提速：写画布零间隔
	storage.set('schHeaderSwapConfig', JSON.stringify({ createIntervalMs: 0 }));

	await api.runNetSwap();
	ok(iframes.some(f => f.url === '/iframe/preview.html'), '打开预览窗口');
	ok(busChannels.includes('header-swap-cmd'), '注册 MessageBus 命令通道');
	const report = JSON.parse(storage.get('schHeaderSwapLastPlan') ?? '{}');
	ok(report.plans?.length === 2 && report.plans.map(p => p.headerDesignator).join(',') === 'J1,U2', `候选器件 J1,U2（实际 ${report.plans?.map(p => p.headerDesignator).join(',')}）`);
	const u2 = report.plans?.find(p => p.headerDesignator === 'U2');
	ok(u2?.metricsBefore?.crossings === 15 && u2?.metricsAfter?.crossings === 0, `U2 镜像 15 交叉 -> 0（实际 ${u2?.metricsBefore?.crossings}->${u2?.metricsAfter?.crossings}）`);
	ok(u2?.changedCount === 6, 'U2 6 脚交换');

	// 应用（MessageBus 模拟预览窗按钮选 U2）；refreshPcbCanvas 关开页签后完成
	globalThis.eda.sys_MessageBus.push('header-swap-cmd', JSON.stringify({ cmd: 'apply', device: 'U2' }));
	for (let w = 0; w < 60 && JSON.parse(storage.get('schHeaderSwapLastPlan') ?? '{}').appliedPcb !== true; w++)
		await new Promise(r => setTimeout(r, 50));
	ok(padModify.length === 6, `U2 六焊盘改写（实际 ${padModify.length}）`);
	ok(padModify.some(p => p.padId === 'pad-U2-1' && p.net === 'IO6'), 'pad-U2-1 -> IO6');
	ok(!padModify.some(p => p.padId.startsWith('pad-J1')), 'J1 焊盘不动');
	ok(pcbSave === 1 && ratlineRefresh === 1, 'PCB 保存 + 鼠线刷新各一次');
	ok(dialogs.some(d => d.includes('已有走线')), '走线警告确认（IO3）');
	ok(JSON.parse(storage.get('schHeaderSwapLastPlan') ?? '{}').appliedPcb === true, '报告标记已应用');

	await api.syncLastSwapToSch();
	for (let j = 1; j <= 6; j++) {
		if (wireNet(`uw${j}`) !== `IO${7 - j}`)
			ok(false, `uw${j} 应为 IO${7 - j}，实际 ${wireNet(`uw${j}`)}`);
	}
	ok(true, '原理图 U2 导线 6 条改写为新网络');
	ok(editorCalls.some(c => c === 'open:sch-1' || c === 'open:sch-page-1'), '定位并打开器件所在图页');
	ok(JSON.parse(storage.get('schHeaderSwapLastPlan') ?? '{}').schSynced === true, '报告标记已同步');

	await api.undoLastSwap();
	ok(padModify.length === 12, `焊盘改写共 12 次（实际 ${padModify.length}）`);
	ok(padModify.some(p => p.padId === 'pad-U2-1' && p.net === 'IO1'), 'pad-U2-1 回 IO1');
	for (let j = 1; j <= 6; j++) {
		if (wireNet(`uw${j}`) !== `IO${j}`)
			ok(false, `uw${j} 恢复应为 IO${j}，实际 ${wireNet(`uw${j}`)}`);
	}
	ok(true, '原理图导线恢复旧网络');
	ok(storage.get('schHeaderSwapLedger') === '', '撤销后台账清理');

	await api.openSettingsPanel();
	ok(iframes.some(f => f.url === '/iframe/settings.html'), '设置面板可打开');
	api.about();
	ok(dialogs.some(d => d.includes('引脚网络重排')), '关于对话框');

	// 错误路径：单网络
	globalThis.eda.pcb_SelectControl.getAllSelectedPrimitives = async () => [primMock({ Net: 'IO1' })];
	await api.runNetSwap();
	ok(dialogs.some(d => d.includes('选中网络不足 2 个')), '单网络引导提示');

	console.log(checks.join('\n'));
	if (failures) {
		console.error(`✗ 冒烟测试 ${failures} 项失败`);
		process.exit(1);
	}
	console.log('✓ bundle 冒烟测试全部通过');
})().catch((e) => {
	console.error('冒烟测试异常:', e);
	process.exit(1);
});
