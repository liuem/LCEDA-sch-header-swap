import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

import extensionConfig from '../extension.json' with { type: 'json' };

import { fixUuid, packageExtension, testUuid } from './utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 主逻辑方法
 */
function main() {
	if (!testUuid(extensionConfig.uuid)) {
		const newExtensionConfig = { ...extensionConfig };
		// @ts-expect-error - Removing default property from extension config
		delete newExtensionConfig.default;
		newExtensionConfig.uuid = fixUuid(extensionConfig.uuid);
		fs.writeJsonSync(path.join(__dirname, '../extension.json'), newExtensionConfig, { spaces: '\t', EOL: '\n', encoding: 'utf-8' });
	}

	const rootDir = path.join(__dirname, '../');
	const extensionName = extensionConfig.name ?? 'extension';
	const extensionVersion = extensionConfig.version ?? '1.0.0';
	// 全新 checkout（如 CI）没有 build/dist 目录，先确保存在再写入
	fs.ensureDirSync(path.join(__dirname, 'dist'));
	const outputPath = path.join(__dirname, 'dist', `${extensionName}_v${extensionVersion}.eext`);

	packageExtension(rootDir, outputPath).then(() => {
		console.log(`Packaging complete: ${outputPath}`);
	}).catch((err) => {
		console.error('Packaging failed:', err);
		process.exit(1);
	});
}

main();
