import { Context } from '@neoworks/extension-system';
import type { Plugin } from '@neoworks/extension-system';
import { mount } from 'svelte';
import workspacePlugins from 'virtual:atlas-plugins';
import './kernel/augment';
import { corePlugins } from './core';
import Shell from './Shell.svelte';

async function mountCorePlugins(root: Context): Promise<void> {
	for (const plugin of corePlugins) {
		await root.plugin(plugin as Plugin);
	}
}

async function mountWorkspacePlugins(root: Context): Promise<void> {
	for (const entry of workspacePlugins) {
		try {
			const loaded = await entry.load();
			await root.plugin(loaded.default as Plugin, entry.config);
		} catch (error) {
			console.error(`[atlas] web plugin ${entry.name} failed`, error);
			root.toasts.push(`Plugin ${entry.name} failed to load its UI: ${String(error)}`, 'error');
		}
	}
}

async function start(): Promise<void> {
	const root = new Context();
	await mountCorePlugins(root);
	await mountWorkspacePlugins(root);

	const target = document.getElementById('app');
	if (!target) {
		throw new Error('index.html is missing #app');
	}
	mount(Shell, { target, props: { kernel: root } });
}

void start();
