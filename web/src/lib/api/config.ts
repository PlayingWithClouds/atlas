import { get, post } from './client';
import type { LabelGroup } from '$lib/labels';

export type AppConfig = {
	// Startup config (immutable).
	title: string;
	primitives: string[];
	labels: { groups: LabelGroup[] };
	default_classes: string[];
	// Runtime-mutable preferences. `backbones` is the list of selectable backbone ids.
	backbone: string;
	backbones: string[];
};

export function getConfig(): Promise<AppConfig> {
	return get('/api/config');
}

export function setBackbone(backbone: string): Promise<AppConfig> {
	return post('/api/config', { backbone });
}
