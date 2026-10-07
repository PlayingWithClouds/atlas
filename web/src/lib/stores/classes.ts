import { writable, get as getStore } from 'svelte/store';
import { browser } from '$app/environment';

const KEY = 'atlas-classes';

function stored(): string[] | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) return JSON.parse(raw);
	} catch {
		// fall through
	}
	return null;
}

// The class list used for new sessions. Seeded from the config's default_classes
// on first run (see seedClasses, called after the config loads), then persisted
// per-browser once the user customizes it.
export const classes = writable<string[]>(stored() ?? []);

if (browser) {
	classes.subscribe((value) => {
		if (value.length) localStorage.setItem(KEY, JSON.stringify(value));
	});
}

// Fill the class list from config defaults when the user has no saved custom set.
export function seedClasses(defaults: string[]): void {
	if (getStore(classes).length === 0) classes.set(defaults);
}
