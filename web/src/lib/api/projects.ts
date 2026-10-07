import { get, post, put, del } from './client';
import type { LabelGroup } from '$lib/labels';

export type ProjectSummary = {
	id: string;
	name: string;
	primitives: string[];
	classes: number;
};

export type ProjectConfig = {
	primitives: string[];
	labels: { groups: LabelGroup[] };
	source?: Record<string, unknown>;
	tagger?: Record<string, unknown>;
	// Id of the model plugin serving this project (embedding backbone + pool +
	// classifier). Defaults to "model"; a temporal/video project uses "siglip".
	model?: string;
	// What this project labels: stills/frames, or temporal clips over a video.
	// Selects which labeler the UI mounts.
	contentKind?: 'image' | 'video';
};

export type Project = {
	id: string;
	name: string;
	config: ProjectConfig;
	created?: string;
	updated?: string;
};

export function listProjects(): Promise<{ projects: ProjectSummary[] }> {
	return get('/api/projects');
}

export function getProject(id: string): Promise<Project> {
	return get(`/api/projects/${id}`);
}

export function createProject(name: string, config?: Partial<ProjectConfig>): Promise<Project> {
	return post('/api/projects', { name, config });
}

export function updateProject(id: string, patch: Partial<ProjectConfig> & { name?: string }): Promise<Project> {
	return put(`/api/projects/${id}`, patch);
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
	return del(`/api/projects/${id}`);
}
