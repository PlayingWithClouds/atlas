<script lang="ts">
	import { page } from '$app/stores';
	import { sessions } from '$lib/stores/sessions';
	import ProjectSwitcher from './ProjectSwitcher.svelte';
	import PluginsIndicator from './PluginsIndicator.svelte';
	import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFour';
	import DatabaseIcon from 'phosphor-svelte/lib/Database';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import FlowArrowIcon from 'phosphor-svelte/lib/FlowArrow';
	import ChartLineIcon from 'phosphor-svelte/lib/ChartLine';
	import GearSixIcon from 'phosphor-svelte/lib/GearSix';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';
	import { openPalette } from '$lib/stores/palette';
	import { available, paneOpen, toggleAssistant } from '$lib/stores/assistant';

	let { project }: { project: string } = $props();

	const nav = [
		{ href: 'overview', label: 'Overview', icon: SquaresFourIcon },
		{ href: 'data', label: 'Data', icon: DatabaseIcon },
		{ href: 'session', label: 'Annotate', icon: PencilSimpleIcon },
		{ href: 'workflows', label: 'Workflows', icon: FlowArrowIcon },
		{ href: 'insights', label: 'Insights', icon: ChartLineIcon },
		{ href: 'settings', label: 'Settings', icon: GearSixIcon }
	];

	const activeSessions = $derived($sessions.filter((s) => !s.done && (s.project ?? 'nsfw-tags') === project));

	function active(href: string): boolean {
		return $page.url.pathname.startsWith(`/projects/${project}/${href}`);
	}
</script>

<aside class="border-line-faint bg-elevated flex h-full w-60 shrink-0 flex-col rounded-xl border shadow-md">
	<ProjectSwitcher {project} />

	<button
		type="button"
		onclick={openPalette}
		class="border-line text-dim hover:text-default mx-3 mt-1 mb-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
	>
		<MagnifyingGlassIcon size={13} />
		<span class="flex-1 text-left">Search…</span>
		<kbd class="border-line rounded border px-1 text-[10px]">⌘K</kbd>
	</button>

	<div class="min-h-0 flex-1 overflow-y-auto pb-2">
		<nav class="flex flex-col gap-0.5 px-2">
			{#each nav as item (item.href)}
				<a
					href={`/projects/${project}/${item.href}`}
					class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors {active(item.href)
						? 'bg-hover text-default font-medium'
						: 'text-muted hover:text-default hover:bg-hover/50'}"
				>
					<item.icon size={16} />
					{item.label}
				</a>
			{/each}
		</nav>

		{#if activeSessions.length}
			<div class="mt-4 px-2">
				<div class="text-faint mb-1 px-2.5 text-[10px] font-semibold tracking-wider uppercase">Open</div>
				<div class="flex flex-col gap-0.5">
					{#each activeSessions as s (s.id)}
						{@const unlabeled = Math.max(0, s.total - s.labeled - s.skipped)}
						<a
							href={`/projects/${project}/session/${s.id}`}
							class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs {$page.params.sid === s.id
								? 'bg-hover text-default'
								: 'text-dim hover:text-default hover:bg-hover/50'}"
						>
							<span class="flex-1 truncate">{s.label}</span>
							{#if s.producing}
								<span class="loading loading-xs"></span>
							{:else}
								<span class="text-faint shrink-0 font-mono text-[10px]" title="labeled / unlabeled">
									<span class="text-green">{s.labeled}</span>/<span>{unlabeled}</span>
								</span>
							{/if}
						</a>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	{#if $available.enabled}
		<button
			type="button"
			onclick={toggleAssistant}
			class="mx-2 mb-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors {$paneOpen
				? 'bg-hover text-default font-medium'
				: 'text-muted hover:text-default hover:bg-hover/50'}"
		>
			<SparkleIcon size={16} />
			Assistant
		</button>
	{/if}

	<PluginsIndicator />
</aside>
