import { writable } from 'svelte/store';
import { listProjects, getProject, type ProjectSummary, type Project } from '$lib/api/projects';
import { setLabels } from '$lib/labels';
import { classes } from './classes';

// The project list (for the switcher) and the currently-open project (whose label
// schema is installed into $lib/labels). Each project owns its own taxonomy, so
// switching projects re-seeds the labels + class list.
export const projects = writable<ProjectSummary[]>([]);
export const activeProject = writable<Project | null>(null);

export async function loadProjects(): Promise<ProjectSummary[]> {
	const { projects: list } = await listProjects();
	projects.set(list);
	return list;
}

export async function setActiveProject(id: string): Promise<Project> {
	const project = await getProject(id);
	activeProject.set(project);
	const groups = project.config.labels?.groups ?? [];
	setLabels(groups);
	const defaults = groups.flatMap((g) => g.classes.map((c) => c.name));
	if (defaults.length) classes.set(defaults);
	if (typeof document !== 'undefined') document.title = project.name;
	return project;
}
