/** Route of the labeling screen for one item; ids contain `#`, `:` and `/`, so they are encoded. */
export function labelPath(projectId: string, itemId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/label/${encodeURIComponent(itemId)}`;
}

export function queuePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/queue`;
}

export function apiItemPath(projectId: string, itemId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`;
}

/**
 * The labeling screen for an item, keeping the queue's filter (`search`, "" or "?…"); `at` (asset
 * seconds, where a search matched) makes the player open there.
 */
export function labelHref(projectId: string, itemId: string, search: string, at?: number): string {
	const path = labelPath(projectId, itemId) + search;
	if (at === undefined) {
		return path;
	}
	let separator = '?';
	if (search !== '') {
		separator = '&';
	}
	return `${path}${separator}at=${at.toFixed(2)}`;
}

/** `at` of the current page URL (see labelHref), when there is one. */
export function startFromLocation(): number | undefined {
	const raw = new URLSearchParams(location.search).get('at');
	if (raw === null) {
		return undefined;
	}
	const seconds = Number(raw);
	if (!Number.isFinite(seconds)) {
		return undefined;
	}
	return seconds;
}
