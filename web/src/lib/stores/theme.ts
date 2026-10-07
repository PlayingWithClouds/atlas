import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const KEY = 'atlas-theme';
export type Theme = 'dark' | 'light';

function initial(): Theme {
	if (!browser) return 'dark';
	const stored = localStorage.getItem(KEY);
	return stored === 'light' ? 'light' : 'dark';
}

export const theme = writable<Theme>(initial());

if (browser) {
	theme.subscribe((value) => {
		document.documentElement.setAttribute('data-theme', value);
		localStorage.setItem(KEY, value);
	});
}
