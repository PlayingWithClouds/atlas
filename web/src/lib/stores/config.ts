import { writable } from 'svelte/store';
import { getConfig, type AppConfig } from '$lib/api/config';
import { setLabels } from '$lib/labels';

// The app config, fetched once during the root layout load. Components read the
// taxonomy through $lib/labels (installed by loadAppConfig); this store exposes
// the rest (title, primitives, model/backbone) for pages that need it live.
export const appConfig = writable<AppConfig | null>(null);

export async function loadAppConfig(): Promise<AppConfig> {
	const config = await getConfig();
	setLabels(config.labels?.groups ?? []);
	appConfig.set(config);
	return config;
}
