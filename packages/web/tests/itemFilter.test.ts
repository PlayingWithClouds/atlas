import { describe, expect, test } from 'bun:test';
import { filterFromSearch, filterSearch, hasFilter, labelOptions } from '../src/core/queue/itemFilter';

const taxonomy = {
	version: 1,
	groups: [
		{
			id: 'participants',
			label: 'Participants',
			kind: 'single' as const,
			labels: [
				{ id: 'threesome', name: 'Threesome' },
				{ id: 'old', name: 'Old', deprecated: true }
			]
		}
	]
};

describe('queue filter URLs', () => {
	test('round trip keeps only filter keys, without empty values', () => {
		const filter = filterFromSearch('?unsure=participants.threesome&sort=match&q=&after=x');
		expect(filter).toEqual({ unsure: 'participants.threesome', sort: 'match' });
		expect(filterSearch(filter)).toBe('?unsure=participants.threesome&sort=match');
	});

	test('extra parameters are appended; nothing gives an empty string', () => {
		expect(filterSearch({}, {})).toBe('');
		expect(filterSearch({ label: 'a.b' }, { after: 'id#1' })).toBe('?label=a.b&after=id%231');
	});

	test('sort alone does not count as a filter', () => {
		expect(hasFilter({ sort: 'queue' })).toBe(false);
		expect(hasFilter({ q: 'x' })).toBe(true);
	});

	test('label options skip deprecated labels', () => {
		expect(labelOptions(taxonomy)).toEqual([{ value: 'participants.threesome', label: 'Participants: Threesome' }]);
	});
});
