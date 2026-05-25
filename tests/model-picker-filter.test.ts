import { describe, expect, it } from 'vitest';
import {
	buildBrowseAllPickerItems,
	buildFavoritesPickerItems,
} from '../src/model-picker-filter';
import type { Endpoint, ModelRef } from '../src/types';

function endpoint(over: Partial<Endpoint>): Endpoint {
	return {
		id: 'e1',
		name: 'Test',
		baseURL: 'https://example.com/v1',
		apiKey: '',
		...over,
	};
}

function ref(endpointId: string, slug: string): ModelRef {
	return { endpointId, slug };
}

describe('buildFavoritesPickerItems', () => {
	it('returns favorites in stored order', () => {
		const e = endpoint({
			id: 'e1',
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
		});
		const items = buildFavoritesPickerItems(
			[ref('e1', 'c'), ref('e1', 'a'), ref('e1', 'b')],
			[e],
		);
		expect(items.map((i) => i.ref.slug)).toEqual(['c', 'a', 'b']);
	});

	it('attaches discovered metadata when the slug was discovered', () => {
		const e = endpoint({
			id: 'e1',
			discoveredModels: [{ id: 'a', contextLength: 200_000, promptPrice: 3, completionPrice: 15 }],
		});
		const items = buildFavoritesPickerItems([ref('e1', 'a')], [e]);
		expect(items[0].discovered?.contextLength).toBe(200_000);
		expect(items[0].stale).toBe(false);
		expect(items[0].orphaned).toBe(false);
	});

	it('treats a favorite as not-stale when the slug is in endpoint.models even without discovery', () => {
		const e = endpoint({ id: 'e1', models: ['a'] });
		const items = buildFavoritesPickerItems([ref('e1', 'a')], [e]);
		expect(items[0].stale).toBe(false);
		expect(items[0].discovered).toBeUndefined();
	});

	it('marks favorites whose slug no longer exists as stale', () => {
		const e = endpoint({
			id: 'e1',
			discoveredModels: [{ id: 'a' }],
		});
		const items = buildFavoritesPickerItems([ref('e1', 'gone')], [e]);
		expect(items[0].stale).toBe(true);
		expect(items[0].orphaned).toBe(false);
	});

	it('marks favorites whose endpoint was deleted as orphaned with id as endpointName fallback', () => {
		const items = buildFavoritesPickerItems(
			[ref('removed-endpoint', 'orphan-slug')],
			[endpoint({ id: 'e1' })],
		);
		expect(items[0].orphaned).toBe(true);
		expect(items[0].stale).toBe(true);
		expect(items[0].endpointName).toBe('removed-endpoint');
	});

	it('returns an empty array when there are no favorites', () => {
		expect(buildFavoritesPickerItems([], [endpoint({})])).toEqual([]);
	});

	it('preserves favorite ordering across multiple endpoints', () => {
		const a = endpoint({ id: 'a', name: 'A', discoveredModels: [{ id: 'x' }] });
		const b = endpoint({ id: 'b', name: 'B', discoveredModels: [{ id: 'y' }] });
		const items = buildFavoritesPickerItems(
			[ref('b', 'y'), ref('a', 'x')],
			[a, b],
		);
		expect(items.map((i) => i.ref)).toEqual([ref('b', 'y'), ref('a', 'x')]);
		expect(items[0].endpointName).toBe('B');
		expect(items[1].endpointName).toBe('A');
	});
});

describe('buildBrowseAllPickerItems', () => {
	it('flattens every discovered + manual slug across all endpoints', () => {
		const a = endpoint({
			id: 'a',
			models: ['manual-only'],
			discoveredModels: [{ id: 'shared' }, { id: 'a-only' }],
		});
		const b = endpoint({
			id: 'b',
			discoveredModels: [{ id: 'b-only' }],
		});
		const items = buildBrowseAllPickerItems([a, b], []);
		const slugs = items.map((i) => i.ref.slug).sort();
		expect(slugs).toEqual(['a-only', 'b-only', 'manual-only', 'shared']);
	});

	it('marks favorites with isFavorite=true', () => {
		const e = endpoint({
			id: 'e1',
			discoveredModels: [{ id: 'a' }, { id: 'b' }],
		});
		const items = buildBrowseAllPickerItems([e], [ref('e1', 'b')]);
		const fav = items.find((i) => i.ref.slug === 'b');
		const non = items.find((i) => i.ref.slug === 'a');
		expect(fav?.isFavorite).toBe(true);
		expect(non?.isFavorite).toBe(false);
	});

	it('sorts favorites before non-favorites, then alphabetical by slug', () => {
		const e = endpoint({
			id: 'e1',
			discoveredModels: [{ id: 'apple' }, { id: 'banana' }, { id: 'cherry' }, { id: 'date' }],
		});
		const items = buildBrowseAllPickerItems(
			[e],
			[ref('e1', 'date'), ref('e1', 'cherry')],
		);
		expect(items.map((i) => i.ref.slug)).toEqual(['cherry', 'date', 'apple', 'banana']);
	});

	it('de-dupes when a slug appears in both manual list and discovered', () => {
		const e = endpoint({
			id: 'e1',
			models: ['shared'],
			discoveredModels: [{ id: 'shared' }, { id: 'discovered-only' }],
		});
		const items = buildBrowseAllPickerItems([e], []);
		const sharedRows = items.filter((i) => i.ref.slug === 'shared');
		expect(sharedRows).toHaveLength(1);
		// The discovered metadata should be attached (not lost to the manual slug).
		expect(sharedRows[0].discovered).toEqual({ id: 'shared' });
	});

	it('treats same slug on different endpoints as distinct rows', () => {
		const a = endpoint({ id: 'a', name: 'A', discoveredModels: [{ id: 'shared' }] });
		const b = endpoint({ id: 'b', name: 'B', discoveredModels: [{ id: 'shared' }] });
		const items = buildBrowseAllPickerItems([a, b], []);
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.ref)).toEqual([
			{ endpointId: 'a', slug: 'shared' },
			{ endpointId: 'b', slug: 'shared' },
		]);
	});

	it('returns an empty array when no endpoints have any models', () => {
		const e = endpoint({ id: 'e1' });
		expect(buildBrowseAllPickerItems([e], [])).toEqual([]);
	});
});
