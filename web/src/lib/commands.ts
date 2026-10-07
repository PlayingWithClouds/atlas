import { goto } from '$app/navigation';
import { get } from 'svelte/store';
import { projects, setActiveProject } from '$lib/stores/projects';
import { theme } from '$lib/stores/theme';

export type Command = { id: string; title: string; group: string; hint?: string; run: () => void | Promise<void> };

const NAV: [string, string][] = [
	['overview', 'Overview'],
	['data', 'Data'],
	['annotate', 'Annotate'],
	['review', 'Review'],
	['workflows', 'Workflows'],
	['insights', 'Insights'],
	['settings', 'Settings']
];

export function buildCommands(projectId: string): Command[] {
	const commands: Command[] = [];
	for (const [href, label] of NAV) {
		commands.push({
			id: `nav:${href}`,
			title: `Go to ${label}`,
			group: 'Navigate',
			run: () => goto(`/projects/${projectId}/${href}`)
		});
	}
	for (const p of get(projects)) {
		if (p.id === projectId) continue;
		commands.push({
			id: `proj:${p.id}`,
			title: `Switch to ${p.name}`,
			group: 'Projects',
			run: async () => {
				await setActiveProject(p.id);
				goto(`/projects/${p.id}/overview`);
			}
		});
	}
	commands.push({ id: 'new-project', title: 'New project…', group: 'Projects', run: () => goto('/projects') });
	commands.push({
		id: 'theme',
		title: 'Toggle light / dark theme',
		group: 'App',
		run: () => theme.update((t) => (t === 'dark' ? 'light' : 'dark'))
	});
	return commands;
}
