import type { ItemFilterQuery, Taxonomy } from '@atlas/contracts';

/** URL parameters that narrow the queue; they travel from the queue into labeling and back. */
const FILTER_KEYS = ['q', 'similar', 'label', 'unsure', 'sort'] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type QueueFilter = Partial<Record<FilterKey, string>>;

export function filterFromSearch(search: string): QueueFilter {
	const parameters = new URLSearchParams(search);
	const filter: QueueFilter = {};
	for (const key of FILTER_KEYS) {
		const value = parameters.get(key);
		if (value !== null && value !== '') {
			filter[key] = value;
		}
	}
	return filter;
}

/** The filter of the current page URL. */
export function currentFilter(): QueueFilter {
	return filterFromSearch(location.search);
}

export function hasFilter(filter: QueueFilter): boolean {
	return filter.q !== undefined || filter.similar !== undefined || filter.label !== undefined || filter.unsure !== undefined;
}

/** `?label=…&unsure=…` (empty when nothing is set), for page URLs and API calls alike. */
export function filterSearch(filter: QueueFilter, extra: Record<string, string> = {}): string {
	const parameters = new URLSearchParams();
	for (const key of FILTER_KEYS) {
		const value = filter[key];
		if (value !== undefined && value !== '') {
			parameters.set(key, value);
		}
	}
	for (const [key, value] of Object.entries(extra)) {
		parameters.set(key, value);
	}
	const text = parameters.toString();
	if (text === '') {
		return '';
	}
	return `?${text}`;
}

export type FilterSort = NonNullable<ItemFilterQuery['sort']>;

export interface LabelOption {
	value: string;
	label: string;
}

/** `group.label` options named "Group: Label", without deprecated labels. */
export function labelOptions(taxonomy: Taxonomy): LabelOption[] {
	return taxonomy.groups.flatMap((group) =>
		group.labels
			.filter((label) => label.deprecated !== true)
			.map((label) => ({ value: `${group.id}.${label.id}`, label: `${group.label}: ${label.name}` }))
	);
}

/** Group options for "unsure about any label of". */
export function groupOptions(taxonomy: Taxonomy): LabelOption[] {
	return taxonomy.groups.map((group) => ({ value: group.id, label: `${group.label}: any` }));
}
