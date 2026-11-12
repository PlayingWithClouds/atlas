import { describe, expect, test } from 'bun:test';
import { addRange } from '../../src/core/labeling/ranges';
import { emptyDraft, toggleLabel } from '../../src/core/labeling/draft';
import { DraftStore, fitToTaxonomy } from '../../src/core/labeling/draftStore';
import type { KeyValueStorage } from '../../src/core/labeling/draftStore';
import { taxonomy } from './fixtures';

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		get length() {
			return map.size;
		},
		key: (index) => [...map.keys()][index] ?? null,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key)
	};
}

const activity = taxonomy.groups.find((group) => group.id === 'activity')!;

describe('stored drafts', () => {
	test('round trip, and clearing', () => {
		const store = new DraftStore(memoryStorage(), memoryStorage());
		const draft = toggleLabel(taxonomy, emptyDraft(), activity, 'talking');
		store.saveDraft('p', 'item#1', draft, '2026-11-12T10:00:00Z');
		expect(store.loadDraft('p', 'item#1')).toMatchObject({ draft, base: '2026-11-12T10:00:00Z' });
		expect(store.loadDraft('p', 'item#2')).toBeUndefined();
		store.clearDraft('p', 'item#1');
		expect(store.loadDraft('p', 'item#1')).toBeUndefined();
	});

	test('drafts older than 30 days are dropped', () => {
		let now = 0;
		const store = new DraftStore(memoryStorage(), memoryStorage(), () => now);
		store.saveDraft('p', 'a', emptyDraft(), null);
		now = 31 * 24 * 60 * 60 * 1000;
		expect(store.loadDraft('p', 'a')).toBeUndefined();
	});

	test('beyond the maximum the oldest drafts make room', () => {
		let now = 0;
		const drafts = memoryStorage();
		const store = new DraftStore(drafts, memoryStorage(), () => now);
		for (let index = 0; index < 205; index += 1) {
			now = index;
			store.saveDraft('p', `item${index}`, emptyDraft(), null);
		}
		expect(drafts.map.size).toBe(200);
		expect(store.loadDraft('p', 'item0')).toBeUndefined();
		expect(store.loadDraft('p', 'item204')).toBeDefined();
	});

	test('a full storage stores nothing and does not throw', () => {
		const full = memoryStorage();
		full.setItem = () => {
			throw new Error('QuotaExceededError');
		};
		const store = new DraftStore(full, full);
		expect(() => store.saveDraft('p', 'a', emptyDraft(), null)).not.toThrow();
	});
});

describe('stored histories', () => {
	test('per item, empty ones are removed', () => {
		const histories = memoryStorage();
		const store = new DraftStore(memoryStorage(), histories);
		const step = toggleLabel(taxonomy, emptyDraft(), activity, 'dancing');
		store.saveHistory('p', 'a', { undo: [emptyDraft(), step], redo: [] });
		expect(store.loadHistory('p', 'a').undo).toEqual([emptyDraft(), step]);
		expect(store.loadHistory('p', 'b')).toEqual({ undo: [], redo: [] });
		store.saveHistory('p', 'a', { undo: [], redo: [] });
		expect(histories.map.size).toBe(0);
	});
});

describe('fitting a stored draft to the taxonomy', () => {
	test('removed labels and groups go', () => {
		let draft = toggleLabel(taxonomy, emptyDraft(), activity, 'talking');
		draft = { ...draft, values: { ...draft.values, gone: ['x'], activity: ['talking', 'removed'] } };
		draft = addRange(taxonomy, draft, { group: 'activity', label: 'dancing', start: 1, end: 2 });
		draft = { ...draft, ranges: [...draft.ranges, { group: 'activity', label: 'removed', start: 0, end: 1 }] };
		const fitted = fitToTaxonomy(taxonomy, draft);
		expect(fitted.values).toEqual({ activity: ['talking'] });
		expect(fitted.ranges).toEqual([{ group: 'activity', label: 'dancing', start: 1, end: 2 }]);
	});
});
