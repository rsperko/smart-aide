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
			showAll: true,
		});
		const slugs = items
			.filter((i) => i.kind === 'model')
			.map((i) => (i as { slug: string }).slug);
		// cherry (recent) → banana (curated) → apple/date (alphabetical)
		expect(slugs).toEqual(['cherry', 'banana', 'apple', 'date']);
	});
});
