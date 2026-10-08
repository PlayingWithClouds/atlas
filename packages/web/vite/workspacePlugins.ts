import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:atlas-plugins';
const RESOLVED_ID = '\0virtual:atlas-plugins';

interface PluginEntry {
	package: string;
	path?: string;
	enabled?: boolean;
	config?: Record<string, unknown>;
}

function readJson(filePath: string): Record<string, any> {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readEnabledEntries(workspaceDirectory: string): PluginEntry[] {
	const configPath = path.join(workspaceDirectory, 'atlas.json');
	if (!fs.existsSync(configPath)) {
		return [];
	}
	const config = readJson(configPath);
	if (!Array.isArray(config.plugins)) {
		return [];
	}
	return config.plugins.filter((entry: PluginEntry) => entry.enabled !== false);
}

function packageDirectoryOf(entry: PluginEntry, workspaceDirectory: string): string {
	if (entry.path !== undefined) {
		return path.resolve(workspaceDirectory, entry.path);
	}
	const requireFromWorkspace = createRequire(path.join(workspaceDirectory, 'atlas.json'));
	return path.dirname(requireFromWorkspace.resolve(`${entry.package}/package.json`));
}

/** Absolute path of the plugin's `atlas.web` entry, or undefined when it ships no web part. */
function webEntryOf(entry: PluginEntry, workspaceDirectory: string): string | undefined {
	const packageDirectory = packageDirectoryOf(entry, workspaceDirectory);
	const manifest = readJson(path.join(packageDirectory, 'package.json'));
	if (!manifest.atlas || !manifest.atlas.web) {
		return undefined;
	}
	return path.resolve(packageDirectory, manifest.atlas.web);
}

function describeEntry(entry: PluginEntry, workspaceDirectory: string): string | undefined {
	let webEntry: string | undefined;
	try {
		webEntry = webEntryOf(entry, workspaceDirectory);
	} catch (error) {
		console.warn(`[atlas] skipping web part of ${entry.package}: ${(error as Error).message}`);
		return undefined;
	}
	if (webEntry === undefined) {
		return undefined;
	}
	const name = JSON.stringify(entry.package);
	const config = JSON.stringify(entry.config === undefined ? {} : entry.config);
	return `{ name: ${name}, config: ${config}, load: () => import(${JSON.stringify(webEntry)}) }`;
}

export function generateModuleSource(workspaceDirectory: string): string {
	const descriptions = readEnabledEntries(workspaceDirectory)
		.map((entry) => describeEntry(entry, workspaceDirectory))
		.filter((description): description is string => description !== undefined);
	return `export default [\n${descriptions.join(',\n')}\n];\n`;
}

/** Generates `virtual:atlas-plugins` from the workspace's atlas.json (ATLAS_WORKSPACE). */
export function atlasWorkspacePlugins(workspaceDirectory: string): Plugin {
	const configPath = path.join(workspaceDirectory, 'atlas.json');
	return {
		name: 'atlas-workspace-plugins',
		resolveId(id) {
			if (id === VIRTUAL_ID) {
				return RESOLVED_ID;
			}
			return undefined;
		},
		load(id) {
			if (id !== RESOLVED_ID) {
				return undefined;
			}
			return generateModuleSource(workspaceDirectory);
		},
		configureServer(server) {
			server.watcher.add(configPath);
			const reloadOnConfigChange = (changed: string) => {
				if (changed !== configPath) {
					return;
				}
				const module = server.moduleGraph.getModuleById(RESOLVED_ID);
				if (module) {
					server.moduleGraph.invalidateModule(module);
				}
				server.ws.send({ type: 'full-reload' });
			};
			server.watcher.on('change', reloadOnConfigChange);
			server.watcher.on('add', reloadOnConfigChange);
		}
	};
}
