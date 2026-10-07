import { writable, derived } from 'svelte/store';

export type PluginCapability = { name: string; [key: string]: unknown };
export type PluginStatus = {
	id: string;
	url: string;
	healthy: boolean;
	capabilities: PluginCapability[];
	error: string | null;
};

// Plugin health + capabilities, pushed live over the WebSocket snapshot.
export const plugins = writable<PluginStatus[]>([]);

// Healthy plugins advertising a given capability — drives graceful-degrade UI
// (an action disables when no plugin provides its capability).
export function providersOf(capability: string) {
	return derived(plugins, ($plugins) =>
		$plugins.filter((p) => p.healthy && p.capabilities.some((c) => c.name === capability))
	);
}

export function hasCapability(capability: string) {
	return derived(plugins, ($plugins) =>
		$plugins.some((p) => p.healthy && p.capabilities.some((c) => c.name === capability))
	);
}
