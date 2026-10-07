import { writable } from 'svelte/store';

export const paletteOpen = writable(false);
export const paletteQuery = writable('');

export function openPalette(): void {
	paletteQuery.set('');
	paletteOpen.set(true);
}

export function closePalette(): void {
	paletteOpen.set(false);
}

export function togglePalette(): void {
	paletteOpen.update((v) => !v);
}
