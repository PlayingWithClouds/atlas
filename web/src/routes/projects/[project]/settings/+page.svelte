<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { classes } from '$lib/stores/classes';
	import { defaultClasses, groupOrder, metaFor, isKnown } from '$lib/labels';
	import { getConfig, setBackbone } from '$lib/api/config';
	import { getProject, updateProject } from '$lib/api/projects';
	import { providersOf } from '$lib/stores/plugins';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

	// --- embedding backbone config -------------------------------------------
	let backbone = $state('');
	let backbones = $state<string[]>([]);
	let backboneSaved = $state(false);

	async function loadConfig() {
		try {
			const config = await getConfig();
			backbone = config.backbone;
			backbones = config.backbones;
		} catch {
			// backend down
		}
	}

	async function saveBackbone() {
		try {
			await setBackbone(backbone);
			backboneSaved = true;
			setTimeout(() => (backboneSaved = false), 1500);
		} catch {
			// ignore
		}
	}

	// --- per-project model plugin --------------------------------------------
	// Which model plugin serves this project. Options are the healthy plugins
	// advertising the "model" capability (each carries its backbone). The default
	// project is owned by atlas.config.json, so its model is read-only here.
	const projectId = $derived($page.params.project ?? '');
	const isDefaultProject = $derived(projectId === 'nsfw-tags');
	const modelPlugins = providersOf('model');
	let model = $state('model');
	let contentKind = $state<'image' | 'video'>('image');
	let modelSaved = $state(false);

	const modelOptions = $derived(
		$modelPlugins.map((p) => {
			const cap = p.capabilities.find((c) => c.name === 'model');
			const backboneName = typeof cap?.backbone === 'string' ? cap.backbone : '';
			return { id: p.id, label: backboneName ? `${p.id} — ${backboneName}` : p.id };
		})
	);

	async function loadProject() {
		try {
			const project = await getProject(projectId);
			model = project.config.model ?? 'model';
			contentKind = project.config.contentKind === 'video' ? 'video' : 'image';
			// A non-default project owns its taxonomy in its label schema; seed the
			// editor from it so edits round-trip (the default project stays config-driven).
			if (!isDefaultProject) {
				const own = projectClasses(project.config.labels?.groups ?? []);
				if (own.length) text = toText(own);
			}
		} catch {
			// backend down / default project
		}
	}

	function projectClasses(groups: { classes: { name: string }[] }[]): string[] {
		return groups.flatMap((group) => group.classes.map((cls) => cls.name));
	}

	// Group a flat class list back into the label-schema shape the backend reads
	// (project.Classes flattens groups, so grouping is only for display fidelity).
	function buildGroups(names: string[]) {
		const byGroup = new Map<string, { name: string }[]>();
		for (const name of names) {
			const group = metaFor(name).group;
			if (!byGroup.has(group)) byGroup.set(group, []);
			byGroup.get(group)!.push({ name });
		}
		return [...byGroup].map(([id, classes]) => ({ id, classes }));
	}

	// Switching to clips nudges the model to the clip backbone if one is up — a nudge,
	// not a rule: another plugin id could serve video later.
	function chooseContentKind(value: 'image' | 'video') {
		contentKind = value;
		if (value !== 'video') return;
		if (model !== 'model' && model !== 'joytag') return;
		if (modelOptions.some((option) => option.id === 'siglip')) model = 'siglip';
	}

	const modelMismatch = $derived(contentKind === 'image' && model === 'siglip');

	async function saveModel() {
		if (isDefaultProject) return;
		try {
			await updateProject(projectId, { model, contentKind });
			modelSaved = true;
			setTimeout(() => (modelSaved = false), 1500);
		} catch {
			// ignore
		}
	}

	onMount(() => {
		loadConfig();
		loadProject();
	});

	// Render the current class list grouped, with `# group` headers, as editable text.
	function toText(list: string[]): string {
		const byGroup = new Map<string, string[]>();
		for (const name of list) {
			const group = metaFor(name).group;
			if (!byGroup.has(group)) byGroup.set(group, []);
			byGroup.get(group)!.push(name);
		}
		const lines: string[] = [];
		for (const group of groupOrder()) {
			const items = byGroup.get(group);
			if (!items?.length) continue;
			lines.push(`# ${group}`);
			lines.push(...items);
			lines.push('');
		}
		return lines.join('\n').trim();
	}

	function parse(text: string): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('#')) continue;
			if (!seen.has(line)) {
				seen.add(line);
				out.push(line);
			}
		}
		return out;
	}

	let text = $state(toText($classes));
	let saved = $state(false);

	const parsed = $derived(parse(text));
	const unknown = $derived(parsed.filter((name) => !isKnown(name)));

	async function save() {
		classes.set(parsed);
		// Persist the taxonomy onto the project's own label schema so the backend's
		// project.Classes() sees it (required before a session can start). The default
		// project is config-file-owned and can't be patched here.
		if (!isDefaultProject) {
			try {
				await updateProject(projectId, { labels: { groups: buildGroups(parsed) } });
			} catch {
				// ignore — the client store is still updated
			}
		}
		saved = true;
		setTimeout(() => (saved = false), 1500);
	}

	function reset() {
		text = toText(defaultClasses());
	}
</script>

<div class="mx-auto max-w-2xl p-6">
	<h1 class="text-default mb-1 text-xl font-semibold tracking-tight">Settings</h1>

	<!-- Embedding backbone -->
	<div class="border-line bg-surface mt-4 mb-6 rounded-lg border p-4">
		<div class="text-default mb-1 text-sm font-semibold">Embedding backbone</div>
		<p class="text-dim mb-3 text-xs">
			The frozen vision model the active-learning head trains on. JoyTag is NSFW-tuned and
			benchmarks far higher than DINOv2 on acts/positions.
		</p>
		<div class="flex gap-2">
			<select class="input flex-1" bind:value={backbone}>
				{#each backbones as b (b)}<option value={b}>{b}</option>{/each}
			</select>
			<button type="button" class="btn btn-primary" onclick={saveBackbone}>
				{#if backboneSaved}<CheckIcon size={15} /> Saved{:else}Save{/if}
			</button>
		</div>
		<div class="text-amber mt-2 text-[11px]">
			Changing the backbone resets the training pool — reopen a source to re-embed with the new
			model. First JoyTag use downloads ~366&nbsp;MB.
		</div>
	</div>

	<!-- Per-project model plugin -->
	<div class="border-line bg-surface mt-4 mb-6 rounded-lg border p-4">
		<div class="text-default mb-1 text-sm font-semibold">Content &amp; model</div>
		<p class="text-dim mb-3 text-xs">
			What this project labels, and the plugin that embeds and classifies it. Video clips are time
			ranges cut by a segment node and are labeled in the clip player; use <code>siglip</code> for
			them, <code>model</code>/<code>joytag</code> for per-frame images.
		</p>
		<div class="mb-2 flex gap-2">
			<select
				class="input flex-1"
				value={contentKind}
				onchange={(e) => chooseContentKind(e.currentTarget.value as 'image' | 'video')}
				disabled={isDefaultProject}
			>
				<option value="image">Images — stills and extracted frames</option>
				<option value="video">Video clips — temporal spans</option>
			</select>
		</div>
		<div class="flex gap-2">
			<select class="input flex-1" bind:value={model} disabled={isDefaultProject}>
				{#each modelOptions as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
			</select>
			<button type="button" class="btn btn-primary" onclick={saveModel} disabled={isDefaultProject}>
				{#if modelSaved}<CheckIcon size={15} /> Saved{:else}Save{/if}
			</button>
		</div>
		{#if isDefaultProject}
			<div class="text-dim mt-2 text-[11px]">
				The default project is defined in atlas.config.json — edit the file to change its model.
			</div>
		{:else}
			<div class="text-amber mt-2 text-[11px]">
				Each model keeps its own pool (different embedding dimensions), so switching starts a fresh
				pool — re-embed the project's sources afterward.
			</div>
			{#if modelMismatch}
				<div class="text-amber mt-1 text-[11px]">
					SigLIP embeds clips; it works on stills as a single-frame clip, but joytag is stronger there.
				</div>
			{/if}
		{/if}
	</div>

	<h2 class="text-default mb-1 text-sm font-semibold">Taxonomy</h2>
	<p class="text-dim mb-6 text-sm">
		The class list used for new sessions. One tag per line; <code>#</code> lines are group headers
		(ignored). Tags matching the built-in taxonomy get icons and definitions in the labeler.
	</p>

	<div class="mb-3 flex items-center gap-3">
		<span class="text-dim text-sm">{parsed.length} classes</span>
		{#if unknown.length}
			<span class="text-amber text-xs">{unknown.length} not in taxonomy (still usable): {unknown.slice(0, 5).join(', ')}{unknown.length > 5 ? '…' : ''}</span>
		{/if}
		<div class="ml-auto flex gap-2">
			<button type="button" class="btn btn-sm btn-ghost" onclick={reset}>Reset to default</button>
			<button type="button" class="btn btn-sm btn-primary" onclick={save}>
				{#if saved}<CheckIcon size={15} /> Saved{:else}Save{/if}
			</button>
		</div>
	</div>

	<textarea
		class="input h-[60vh] w-full resize-none py-3 font-mono text-xs leading-relaxed"
		spellcheck="false"
		bind:value={text}
	></textarea>
</div>
