import { describe, expect, it } from 'vitest';
import { buildModelPickerItems } from '../src/model-picker-filter';
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

describe('buildModelPickerItems — curated-only default', () => {
	it('returns only curated models when showAll=false and endpoint has both curated + discovered', () => {
		const e = endpoint({
			id: 'e1',
			models: ['claude-haiku-4.5', 'claude-sonnet-4.6'],
			discoveredModels: [
				{ id: 'claude-haiku-4.5' },
				{ id: 'claude-sonnet-4.6' },
				{ id: 'claude-opus-4.7' },
				{ id: 'claude-3-5-sonnet' },
			],
		});
		const result = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'claude-haiku-4.5'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		const slugs = result.items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		expect(slugs).toEqual(['claude-haiku-4.5', 'claude-sonnet-4.6']);
		expect(result.hiddenCount).toBe(2);
	});

	it('appends an Expand toggle item when hidden discovered models exist', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
		});
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		const last = items[items.length - 1];
		expect(last.kind).toBe('toggle');
		if (last.kind === 'toggle') {
			expect(last.mode).toBe('expand');
			expect(last.label).toBe('Show all 2 discovered models ↓');
		}
	});

	it('omits the toggle when nothing is hidden (curated == discovered)', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a', 'b'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }],
		});
		const { items, hiddenCount } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		expect(hiddenCount).toBe(0);
		expect(items.every((i) => i.kind === 'model')).toBe(true);
	});
});

describe('buildModelPickerItems — always-visible refs', () => {
	it('keeps the current model visible even when not in the curated list', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a', 'b'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'rare-model' }],
		});
		const result = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'rare-model'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		const slugs = result.items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		expect(slugs).toContain('rare-model');
	});

	it('keeps recent models visible even when not curated, in recents order', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
		});
		const result = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [ref('e1', 'c'), ref('e1', 'b')],
			favorites: [],
			showAll: false,
		});
		const slugs = result.items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		// recents come first, in their stored order
		expect(slugs.slice(0, 2)).toEqual(['c', 'b']);
		expect(slugs).toContain('a');
		expect(slugs).not.toContain('d');
	});
});

describe('buildModelPickerItems — endpoint with no curation', () => {
	it('treats every discovered model as visible when endpoint.models is empty', () => {
		const e = endpoint({
			id: 'e1',
			models: [],
			discoveredModels: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
		});
		const result = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'x'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		const slugs = result.items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		expect(slugs.sort()).toEqual(['x', 'y', 'z']);
		expect(result.hiddenCount).toBe(0);
	});
});

describe('buildModelPickerItems — showAll mode', () => {
	it('shows every curated + discovered slug when showAll=true', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
		});
		const result = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [],
			showAll: true,
		});
		const slugs = result.items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		expect(slugs.sort()).toEqual(['a', 'b', 'c']);
	});

	it('appends a Collapse toggle in expanded mode', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }],
		});
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [],
			showAll: true,
		});
		const last = items[items.length - 1];
		expect(last.kind).toBe('toggle');
		if (last.kind === 'toggle') {
			expect(last.mode).toBe('collapse');
			expect(last.label).toBe('Show curated only ↑');
		}
	});
});

describe('buildModelPickerItems — multi-endpoint', () => {
	it('keys de-dup by endpoint+slug so the same slug on two endpoints both appear', () => {
		const a = endpoint({ id: 'a', name: 'A', models: ['shared'] });
		const b = endpoint({ id: 'b', name: 'B', models: ['shared'] });
		const result = buildModelPickerItems({
			endpoints: [a, b],
			current: ref('a', 'shared'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		const refs = result.items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { ref: ModelRef }).ref);
		expect(refs).toEqual([
			{ endpointId: 'a', slug: 'shared' },
			{ endpointId: 'b', slug: 'shared' },
		]);
	});

	it('sums hiddenCount across endpoints', () => {
		const a = endpoint({
			id: 'a',
			models: ['x'],
			discoveredModels: [{ id: 'x' }, { id: 'y' }],
		});
		const b = endpoint({
			id: 'b',
			models: ['p'],
			discoveredModels: [{ id: 'p' }, { id: 'q' }, { id: 'r' }],
		});
		const { items, hiddenCount } = buildModelPickerItems({
			endpoints: [a, b],
			current: ref('a', 'x'),
			recents: [],
			favorites: [],
			showAll: false,
		});
		expect(hiddenCount).toBe(3);
		// The expand toggle reflects the sum.
		const toggle = items[items.length - 1];
		expect(toggle.kind).toBe('toggle');
		if (toggle.kind === 'toggle') {
			expect(toggle.label).toBe('Show all 3 discovered models ↓');
		}
	});
});

describe('buildModelPickerItems — sort order', () => {
	it('orders by recents, then curated, then alphabetical slug', () => {
		const e = endpoint({
			id: 'e1',
			models: ['banana'],
			discoveredModels: [{ id: 'apple' }, { id: 'banana' }, { id: 'cherry' }, { id: 'date' }],
		});
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'banana'),
			recents: [ref('e1', 'cherry')],
			favorites: [],
			showAll: true,
		});
		const slugs = items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		// cherry (recent) → banana (curated) → apple/date (alphabetical)
		expect(slugs).toEqual(['cherry', 'banana', 'apple', 'date']);
	});
});

describe('buildModelPickerItems — favorites', () => {
	it('marks favorited models with isFavorite=true', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a', 'b'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }],
		});
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [ref('e1', 'b')],
			showAll: false,
		});
		const models = items.filter((i) => i.kind === 'model') as Array<{ slug: string; isFavorite: boolean }>;
		expect(models.find((m) => m.slug === 'b')?.isFavorite).toBe(true);
		expect(models.find((m) => m.slug === 'a')?.isFavorite).toBe(false);
	});

	it('sorts favorites before recents and curated', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a', 'b'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
		});
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [ref('e1', 'c')],
			favorites: [ref('e1', 'd'), ref('e1', 'b')],
			showAll: true,
		});
		const slugs = items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		// favorites in given order → recents → curated → alphabetical
		expect(slugs).toEqual(['d', 'b', 'c', 'a']);
	});

	it('keeps favorites visible even when curated would hide them', () => {
		const e = endpoint({
			id: 'e1',
			models: ['a'],
			discoveredModels: [{ id: 'a' }, { id: 'b' }, { id: 'rare' }],
		});
		const { items, hiddenCount } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [ref('e1', 'rare')],
			showAll: false,
		});
		const slugs = items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		expect(slugs).toContain('rare');
		// 'b' is still hidden (not curated, not favorite); 'rare' should not be in hiddenCount.
		expect(hiddenCount).toBe(1);
	});

	it('renders stale favorites whose slugs no longer exist in the endpoint', () => {
		// Endpoint has discovered {a, b} but the user has a favorite for slug 'gone'
		// that no longer appears anywhere. We still render it so the user can unstar.
		const e = endpoint({
			id: 'e1',
			models: [],
			discoveredModels: [{ id: 'a' }, { id: 'b' }],
		});
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('e1', 'a'),
			recents: [],
			favorites: [ref('e1', 'gone')],
			showAll: false,
		});
		const slugs = items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		expect(slugs).toContain('gone');
	});

	it('renders favorites for endpoints that no longer exist (using endpointId as fallback name)', () => {
		const e = endpoint({ id: 'still-here', name: 'Here', models: ['a'] });
		const { items } = buildModelPickerItems({
			endpoints: [e],
			current: ref('still-here', 'a'),
			recents: [],
			favorites: [ref('removed-endpoint', 'orphan-slug')],
			showAll: false,
		});
		const models = items.filter((i) => i.kind === 'model') as Array<{
			slug: string;
			endpointName: string;
			isFavorite: boolean;
		}>;
		const orphan = models.find((m) => m.slug === 'orphan-slug');
		expect(orphan).toBeDefined();
		expect(orphan?.isFavorite).toBe(true);
		expect(orphan?.endpointName).toBe('removed-endpoint');
	});
});
