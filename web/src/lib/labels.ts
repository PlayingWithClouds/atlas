// Config-driven label taxonomy. The label set is no longer hardcoded — it comes
// from the backend startup config (GET /api/config → labels.groups) and is
// installed once via setLabels() during the root layout load, before any page
// renders. Everything here reads that installed state synchronously.

export type ClassMeta = { group: string; icon: string; info: string; thumbnail?: string };
export type LabelClass = { name: string; icon?: string; info?: string; thumbnail?: string };
export type LabelGroup = { id: string; label?: string; classes: LabelClass[] };

let _meta: Record<string, ClassMeta> = {};
let _order: string[] = [];
let _groupLabels: Record<string, string> = {};
let _defaults: string[] = [];
// Class → thumbnail URL, drawn from the labeled dataset (GET /api/classes/thumbnails).
let _thumbs: Record<string, string> = {};

// Install the taxonomy from config. Idempotent; called on every config load.
export function setLabels(groups: LabelGroup[]): void {
	_meta = {};
	_order = [];
	_groupLabels = {};
	_defaults = [];
	for (const group of groups) {
		_order.push(group.id);
		_groupLabels[group.id] = group.label ?? group.id;
		for (const cls of group.classes) {
			_meta[cls.name] = {
				group: group.id,
				icon: cls.icon ?? '🏷️',
				info: cls.info ?? '',
				thumbnail: cls.thumbnail
			};
			_defaults.push(cls.name);
		}
	}
	if (!_order.includes('other')) _order.push('other');
}

export function metaFor(name: string): ClassMeta {
	return _meta[name] ?? { group: 'other', icon: '🏷️', info: '' };
}

// Install dataset-derived class thumbnails. Cache-busted so new labels refresh.
export function installThumbnails(thumbs: Record<string, string>): void {
	_thumbs = thumbs;
}

// Per-class thumbnail, best first: a real example from this project's labeled
// entities, else the static illustration the config names for the class, else
// undefined (→ the caller falls back to the emoji icon). Without the config
// fallback a class shows nothing until someone has labeled it, which is exactly
// when a picture of it would help most.
export function categoryIcon(name: string): string | undefined {
	const labeled = _thumbs[name];
	if (labeled) return labeled;
	return _meta[name]?.thumbnail;
}

export function groupOrder(): string[] {
	return _order;
}

export function groupLabel(id: string): string {
	return _groupLabels[id] ?? id;
}

// Default class list for a new session, in config order.
export function defaultClasses(): string[] {
	return _defaults;
}

// True when the tag is part of the configured taxonomy (has icon/definition).
export function isKnown(name: string): boolean {
	return name in _meta;
}

export type GroupedClass = { name: string; index: number } & ClassMeta;
export type ClassGroup = { group: string; label: string; items: GroupedClass[] };

// Group a session's classes preserving config group order; keeps a flat index so
// number-key shortcuts (1–9) still map to the first classes.
export function groupClasses(classes: string[]): ClassGroup[] {
	const byGroup = new Map<string, GroupedClass[]>();
	classes.forEach((name, index) => {
		const meta = metaFor(name);
		if (!byGroup.has(meta.group)) byGroup.set(meta.group, []);
		byGroup.get(meta.group)!.push({ name, index, ...meta });
	});
	const groups: ClassGroup[] = [];
	for (const group of groupOrder()) {
		if (byGroup.has(group)) groups.push({ group, label: groupLabel(group), items: byGroup.get(group)! });
	}
	// Any groups the config didn't declare (safety) go last.
	for (const [group, items] of byGroup) {
		if (!_order.includes(group)) groups.push({ group, label: groupLabel(group), items });
	}
	return groups;
}
