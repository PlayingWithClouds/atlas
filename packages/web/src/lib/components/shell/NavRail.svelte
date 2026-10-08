<script lang="ts">
	import { kernelContext } from '../../../kernel/context';
	import { palette } from '../../../kernel/palette.svelte';
	import ProjectSwitcher from './ProjectSwitcher.svelte';
	import PluginsIndicator from './PluginsIndicator.svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import CircleIcon from 'phosphor-svelte/lib/Circle';

	let { projectId }: { projectId: string } = $props();

	const ctx = kernelContext();

	const openSessions = $derived(
		ctx.live.sessions.filter(
			(session) => session.projectId === projectId && (session.producing || session.total - session.labeled - session.skipped > 0)
		)
	);

	function hrefOf(path: string): string {
		return `/projects/${projectId}/${path}`;
	}

	function isActive(path: string): boolean {
		return ctx.router.path.startsWith(hrefOf(path));
	}

	function isOpenSession(sessionId: string): boolean {
		return ctx.router.current?.params.session === sessionId;
	}
</script>

<aside class="border-line-faint bg-elevated flex h-full w-60 shrink-0 flex-col rounded-xl border shadow-md">
	<ProjectSwitcher {projectId} />

	<button
		type="button"
		onclick={() => palette.show()}
		class="border-line text-dim hover:text-default mx-3 mt-1 mb-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
	>
		<MagnifyingGlassIcon size={13} />
		<span class="flex-1 text-left">Search…</span>
		<kbd class="border-line rounded border px-1 text-[10px]">⌘K</kbd>
	</button>

	<div class="min-h-0 flex-1 overflow-y-auto pb-2">
		<nav class="flex flex-col gap-0.5 px-2">
			{#each ctx.nav.list() as item (item.id)}
				<a
					href={hrefOf(item.path)}
					class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors {isActive(item.path)
						? 'bg-hover text-default font-medium'
						: 'text-muted hover:text-default hover:bg-hover/50'}"
				>
					{#if item.icon}
						<item.icon size={16} />
					{:else}
						<CircleIcon size={16} />
					{/if}
					{item.label}
				</a>
			{/each}
		</nav>

		{#if openSessions.length}
			<div class="mt-4 px-2">
				<div class="text-faint mb-1 px-2.5 text-[10px] font-semibold tracking-wider uppercase">Open</div>
				<div class="flex flex-col gap-0.5">
					{#each openSessions as session (session.id)}
						{@const unlabeled = Math.max(0, session.total - session.labeled - session.skipped)}
						<a
							href={hrefOf(`session/${session.id}`)}
							class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs {isOpenSession(session.id)
								? 'bg-hover text-default'
								: 'text-dim hover:text-default hover:bg-hover/50'}"
						>
							<span class="flex-1 truncate">{session.label}</span>
							{#if session.producing}
								<span class="loading loading-xs"></span>
							{:else}
								<span class="text-faint shrink-0 font-mono text-[10px]" title="labeled / unlabeled">
									<span class="text-green">{session.labeled}</span>/<span>{unlabeled}</span>
								</span>
							{/if}
						</a>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<PluginsIndicator />
</aside>
