<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import CommandMenu, { type MenuCommand } from '$lib/components/CommandMenu.svelte';
	import Toaster from '$lib/components/Toaster.svelte';
	import { listWorkflows, runWorkflow, type Workflow } from '$lib/api/workflows';
	import { available as assistantAvailable, toggleAssistant } from '$lib/stores/assistant';

	let { children } = $props();
	const project = $derived($page.params.project ?? 'nsfw-tags');

	let workflows = $state<Workflow[]>([]);

	onMount(async () => {
		try {
			workflows = (await listWorkflows($page.params.project)).workflows;
		} catch {
			// menu just shows navigation commands if workflows can't load
		}
	});

	// Commands shown by the F1 / Shift+K menu, tailored to the current page: on a
	// labeling session, manual workflows can be run against it; everywhere else the
	// menu falls back to navigation.
	const commands = $derived.by<MenuCommand[]>(() => {
		const list: MenuCommand[] = [];
		const sid = $page.params.sid;
		const manual = workflows.filter(
			(wf) => wf.graph && (!wf.triggers?.length || wf.triggers.includes('manual'))
		);
		if (sid) {
			for (const wf of manual) {
				list.push({
					title: `Run: ${wf.label}`,
					description: (wf.graph?.nodes ?? []).map((n) => n.type).join(' → '),
					action: () => runWorkflow(sid, wf.id)
				});
			}
		}
		if ($assistantAvailable.enabled) {
			list.push({
				title: 'Assistant',
				description: 'Ask about this session, propose labels, draft a workflow',
				action: toggleAssistant
			});
		}
		list.push(
			{ title: 'Workflows', description: 'Open the workflow designer', action: () => goto(`/projects/${project}/workflows`) },
			{ title: 'Data', description: 'Browse sources', action: () => goto(`/projects/${project}/data`) },
			{ title: 'Insights', description: 'Dataset stats', action: () => goto(`/projects/${project}/insights`) }
		);
		return list;
	});
</script>

<AppShell {project}>
	{@render children()}
</AppShell>

<CommandMenu {commands} />
<Toaster />
