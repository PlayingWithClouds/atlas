// Client-side presentation helpers for the workflow node catalog. The catalog
// data itself is fetched from the backend (built-in + plugin nodes); this module
// only maps node types to icons and port states to colors.
import type { Component } from 'svelte';
import type { NodeSpec } from '$lib/api/workflows';
import Database from 'phosphor-svelte/lib/Database';
import FilmStrip from 'phosphor-svelte/lib/FilmStrip';
import Graph from 'phosphor-svelte/lib/Graph';
import Sparkle from 'phosphor-svelte/lib/Sparkle';
import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
import Export from 'phosphor-svelte/lib/Export';
import Cube from 'phosphor-svelte/lib/Cube';
import Copy from 'phosphor-svelte/lib/Copy';
import Gavel from 'phosphor-svelte/lib/Gavel';
import Bell from 'phosphor-svelte/lib/Bell';
import FloppyDisk from 'phosphor-svelte/lib/FloppyDisk';
import Funnel from 'phosphor-svelte/lib/Funnel';
import Shuffle from 'phosphor-svelte/lib/Shuffle';
import Broom from 'phosphor-svelte/lib/Broom';
import Scissors from 'phosphor-svelte/lib/Scissors';
import CirclesThree from 'phosphor-svelte/lib/CirclesThree';
import ShareNetwork from 'phosphor-svelte/lib/ShareNetwork';

const ICONS: Record<string, Component> = {
	source: Database,
	extract: FilmStrip,
	filter: Funnel,
	sample: Shuffle,
	quality: Broom,
	trim: Scissors,
	cluster: CirclesThree,
	propagate: ShareNetwork,
	dedupe: Copy,
	embed: Graph,
	predict: Sparkle,
	save: FloppyDisk,
	action: Gavel,
	notify: Bell,
	review: CheckCircle,
	export: Export
};

export function iconFor(type: string): Component {
	// Plugin nodes are namespaced by their instance ("siglip.predict"); the icon belongs
	// to what the node does, not to which backbone happens to run it.
	const bare = type.slice(type.lastIndexOf('.') + 1);
	return ICONS[type] ?? ICONS[bare] ?? Cube;
}

// Nodes exchange one entity stream; unknown port names get the fallback hue.
const PORT_COLORS: Record<string, string> = {
	entities: '#60a5fa'
};

export function portColor(state: string): string {
	return PORT_COLORS[state] ?? '#94a3b8';
}

// inputTypeLabel describes what a node consumes: the entity stream plus its
// accepts criteria (the exact entities the node works on).
export function inputTypeLabel(spec: NodeSpec): string {
	if (!spec.input) {
		return 'none';
	}
	const criteria = Object.entries(spec.accepts ?? {}).map(([key, value]) => `${key}=${value}`);
	if (criteria.length === 0) {
		return 'entities';
	}
	return `entities (${criteria.join(', ')})`;
}

// outputTypeLabel describes what a node produces: the entity stream plus the
// fields it sets on its output items.
export function outputTypeLabel(spec: NodeSpec): string {
	if (!spec.output) {
		return 'none';
	}
	const fields = Object.entries(spec.emits ?? {}).map(([key, value]) => `+${key}=${value}`);
	if (fields.length === 0) {
		return 'entities';
	}
	return `entities (${fields.join(', ')})`;
}

// outputSatisfies reports whether wiring source → target is provably compatible:
// a connection is rejected only when the source explicitly emits a field value
// that conflicts with the target's accepts (unknown fields may match at runtime,
// e.g. entities already embedded in the database).
export function outputSatisfies(source: NodeSpec, target: NodeSpec): boolean {
	const emits = source.emits ?? {};
	for (const [key, want] of Object.entries(target.accepts ?? {})) {
		if (key in emits && String(emits[key]) !== String(want)) {
			return false;
		}
	}
	return true;
}

export function defaultParams(spec: NodeSpec): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	for (const param of spec.params) {
		params[param.key] = param.default;
	}
	return params;
}

// Context key sharing the fetched catalog (type → spec) with node components.
export const CATALOG_CONTEXT = Symbol('workflow-catalog');
export type CatalogMap = Map<string, NodeSpec>;

// Context key exposing the current Source input shape (a getter, so the Source
// node re-renders when the workflow's triggers change).
export const SOURCE_KIND_CONTEXT = Symbol('workflow-source-kind');
export type SourceKindGetter = () => string;
