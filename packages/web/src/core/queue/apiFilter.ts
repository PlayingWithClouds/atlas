import { settings } from '../settings/settings.svelte';
import { filterSearch } from './itemFilter';
import type { QueueFilter } from './itemFilter';

/** A filter's query for the API: the page URL's filter plus the unsure margin from Settings. */
export function apiFilterSearch(filter: QueueFilter, extra: Record<string, string> = {}): string {
	return filterSearch(filter, { margin: String(settings.value.unsureMargin), ...extra });
}

/** "35–65 %" for a margin of 0.15. */
export function bandText(margin: number): string {
	return `${Math.round((0.5 - margin) * 100)}–${Math.round((0.5 + margin) * 100)} %`;
}
