import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { generateSourcesCss } from '../vite/workspacePlugins';

function pluginPackage(root: string, name: string, manifest: Record<string, unknown>): string {
	const directory = path.join(root, name);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, ...manifest }));
	return directory;
}

test('Tailwind scans the web code of enabled plugins only', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-web-'));
	const withWeb = pluginPackage(root, 'with-web', { atlas: { web: './src/web.ts' } });
	const serverOnly = pluginPackage(root, 'server-only', { atlas: { server: './src/server.ts' } });
	const disabled = pluginPackage(root, 'disabled', { atlas: { web: './src/web.ts' } });
	const plugins = [
		{ package: 'with-web', path: withWeb },
		{ package: 'server-only', path: serverOnly },
		{ package: 'disabled', path: disabled, enabled: false }
	];
	fs.writeFileSync(path.join(root, 'atlas.json'), JSON.stringify({ plugins }));

	const css = generateSourcesCss(root);
	expect(css).toContain(`@source ${JSON.stringify(path.join(withWeb, 'src'))};`);
	expect(css).not.toContain(serverOnly);
	expect(css).not.toContain(disabled);
	fs.rmSync(root, { recursive: true });
});
