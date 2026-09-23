const fs = require('node:fs');
const process = require('node:process');
const JSZip = require('jszip');

const pkg = process.argv[2] || 'build/dist/lceda-sch-header-swap_v0.3.2.eext';
JSZip.loadAsync(fs.readFileSync(pkg)).then(async (z) => {
	const names = Object.keys(z.files).filter(n => !z.files[n].dir);
	console.log('包内文件:');
	names.forEach(n => console.log(' -', n));
	if (!names.includes('iframe/settings.html'))
		throw new Error('缺少 iframe/settings.html（设置面板）');
	if (!names.includes('iframe/preview.html'))
		throw new Error('缺少 iframe/preview.html（预览窗口）');
	// extension.json 声明了 images 字段 -> 包内必须有真实文件（缺失会导致客户端加载失败、菜单不出现）
	for (const img of ['images/logo.png']) {
		if (!names.includes(img))
			throw new Error(`缺少 ${img}（extension.json 已声明，客户端加载不到会不激活）`);
	}
	// 2026-09-23 起不再提供 banner：声明了但文件缺失会导致客户端加载失败/菜单不出现（v0.1.0 踩过的坑），
	// 因此 banner 声明与 banner 文件都必须不存在
	for (const banned of ['images/banner.jpg', 'images/banner.svg']) {
		if (names.includes(banned))
			throw new Error(`包内不应再包含 ${banned}（banner 已弃用）`);
	}
	// 功能演示图必须随包 + README 引用（商店详情页展示 README 时图片要可见）
	const demos = ['demo-menu', 'demo-before', 'demo-select', 'demo-preview', 'demo-after', 'demo-undo-sync', 'demo-settings'];
	for (const d of demos) {
		if (!names.includes(`images/${d}.png`))
			throw new Error(`缺少 images/${d}.png（README 功能演示引用）`);
	}
	const readme = await z.file('README.md').async('string');
	for (const d of demos) {
		if (!readme.includes(`images/${d}.png`))
			throw new Error(`README 未引用 images/${d}.png`);
	}
	// logo 的 SVG 源随包（可复现/编辑）
	for (const svg of ['images/logo.svg']) {
		if (!names.includes(svg))
			throw new Error(`缺少 ${svg}（图像源文件）`);
	}
	const cfg = JSON.parse(await z.file('extension.json').async('string'));
	console.log('版本:', cfg.version, '| 名称:', cfg.name, '| 菜单环境:', Object.keys(cfg.headerMenus).filter(k => cfg.headerMenus[k].length).join(','));
	if (cfg.images?.banner)
		throw new Error('extension.json 不应声明 images.banner（banner 已弃用；声明了但包内无文件会导致客户端不激活）');
	if (!cfg.headerMenus.pcb?.length)
		throw new Error('菜单应挂在 headerMenus.pcb（PCB 插件）');
	console.log('菜单函数:', cfg.headerMenus.pcb[0].menuItems.map(m => m.registerFn).join(', '));
	if (cfg.uuid.length !== 32)
		throw new Error(`uuid 应为 32 位，实际 ${cfg.uuid.length}`);
	if (cfg.name !== 'lceda-sch-header-swap')
		throw new Error(`name 应为 lceda-sch-header-swap，实际 ${cfg.name}`);
	const src = await z.file('dist/index.js').async('string');
	console.log('bundle 大小:', src.length, '字节');
	// esbuild 默认 ascii charset：中文字符串会被转成 \uXXXX 转义（大写十六进制），
	// 但 ASCII 字符（如 /）不转义——esc 只转非 ASCII，两种形式都匹配
	const esc = s => Array.from(s).map(c => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}` : c)).join('');
	const hasStr = s => src.includes(s) || src.includes(esc(s));
	for (const k of ['hungarian', 'solveHeaderSwap', 'virtualBoardPads', 'classifyHeaderPins', 'buildDevicePinsPlan', 'buildPinPlans', 'makePowerMatcher', 'evaluateRatsnest', 'mstEdges', 'AdaptivePacer', 'applyDeviceToPcb', 'syncReportToSch', 'undoSwapLedger', 'collectBoardState', 'findSchPageWithDevice', 'readSelectedPcbNets', 'solveForDevice', 'dmt_Project', 'dmt_EditorControl', 'dmt_SelectControl', 'openDocument', 'activateDocument', 'getCurrentProjectAllNets', 'sch_PrimitiveWire', 'pcb_SelectControl', 'pcb_PrimitivePad', 'pcb_PrimitiveLine', 'pcb_Document', 'startCalculatingRatline', 'getAllSelectedPrimitives', 'getAllPinsByPrimitiveId', 'getState_ParentComponentPrimitiveId', 'schHeaderSwapConfig', 'schHeaderSwapLastPlan', 'schHeaderSwapLedger', '__HDRSWAP_TMP_', 'header-swap-cmd', '引脚网络重排', '撤销上次交换', '同步到原理图', '电源/地名单', 'net-mismatch'])
		console.log(`  含 ${k}:`, hasStr(k));
	// 关键校验：函数导出（headerMenus registerFn 必须都在 bundle 里）
	for (const fn of ['runNetSwap', 'syncLastSwapToSch', 'undoLastSwap', 'openSettingsPanel', 'about']) {
		if (!new RegExp(`(?:function|,)\\s*${fn}\\s*[=(]`).test(src) && !src.includes(`${fn}(`))
			throw new Error(`bundle 缺少导出函数 ${fn}`);
	}
	if (!cfg.headerMenus.pcb[0].menuItems.some(m => m.id === 'shs-run' && m.registerFn === 'runNetSwap'))
		throw new Error('extension.json 缺少「交换选中网络」菜单项');
	const html = await z.file('iframe/settings.html').async('string');
	for (const k of ['schHeaderSwapConfig', 'lockPins', 'powerPatterns', 'weightMode', 'maxRefineIters', 'btnSave', 'btnDefaults', 'btnDefaultPower'])
		console.log(`  面板含 ${k}:`, html.includes(k));
	const prev = await z.file('iframe/preview.html').async('string');
	for (const k of ['schHeaderSwapLastPlan', 'devlist', 'btnApply', 'chosenName', 'header-swap-cmd', 'sys_MessageBus', 'REASON_TEXT'])
		console.log(`  预览含 ${k}:`, prev.includes(k));
	// 回归守卫：不引用文件系统/联网接口（静态扫描会触发"外部交互权限"安装提示）
	for (const banned of ['sys_FileSystem', 'saveFileToFileSystem', 'readFileFromFileSystem', 'WebSocket', 'XMLHttpRequest', 'sendBeacon', 'fetch(']) {
		if (src.includes(banned))
			throw new Error(`bundle 引用了外部交互类接口 ${banned}（会触发权限提示）`);
	}
	// 源码目录不应进包（.edaignore 排除 /src/ /test/ /config/ /build/ 等）
	for (const n of names) {
		if (/^(?:src|test|config|build|docs|node_modules)\//.test(n))
			throw new Error(`包内不应包含源码路径：${n}`);
	}
	console.log('✓ 核验通过');
}).catch((e) => {
	console.error('核验失败:', e.message);
	process.exit(1);
});
