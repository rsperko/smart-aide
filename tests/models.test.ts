import { describe, expect, it } from 'vitest';
import { bumpRecent, DEFAULT_MODEL, DEFAULT_MODEL_LIST, friendlyModelName } from '../src/models';

describe('friendlyModelName', () => {
	it('returns the friendly name for a known slug', () => {
		expect(friendlyModelName('anthropic/claude-haiku-4.5')).toBe('Claude Haiku 4.5');
		expect(friendlyModelName('openai/gpt-5.5')).toBe('GPT-5.5');
	});

	it('falls back to title-casing the tail for an unknown slug', () => {
		expect(friendlyModelName('exotic-vendor/some-new-model')).toBe('Some New Model');
		expect(friendlyModelName('plain_slug')).toBe('Plain Slug');
	});

	it('strips provider prefix and recognizes bare provider slugs', () => {
		// Direct-provider endpoints have no provider/ prefix; we try common ones.
		expect(friendlyModelName('claude-haiku-4.5')).toBe('Claude Haiku 4.5');
		expect(friendlyModelName('gpt-5.5')).toBe('GPT-5.5');
	});
});

describe('bumpRecent', () => {
	it('moves an existing slug to the front', () => {
		const out = bumpRecent(
			[
				{ endpointId: 'a', slug: 'x' },
				{ endpointId: 'a', slug: 'y' },
				{ endpointId: 'a', slug: 'z' },
			],
			{ endpointId: 'a', slug: 'z' },
		);
		expect(out.map((r) => r.slug)).toEqual(['z', 'x', 'y']);
	});

	it('prepends a new slug', () => {
		const out = bumpRecent([{ endpointId: 'a', slug: 'x' }], { endpointId: 'a', slug: 'new' });
		expect(out.map((r) => r.slug)).toEqual(['new', 'x']);
	});

	it('caps the list at the max', () => {
		const base = Array.from({ length: 5 }, (_, i) => ({ endpointId: 'a', slug: `r${i}` }));
		const out = bumpRecent(base, { endpointId: 'a', slug: 'new' }, 5);
		expect(out).toHaveLength(5);
		expect(out[0].slug).toBe('new');
		// r4 (the oldest) should be dropped.
		expect(out.find((r) => r.slug === 'r4')).toBeUndefined();
	});

	it('treats endpointId as part of identity for dedup', () => {
		const out = bumpRecent(
			[
				{ endpointId: 'a', slug: 'm' },
				{ endpointId: 'b', slug: 'm' },
			],
			{ endpointId: 'a', slug: 'm' },
		);
		// b/m should still be present — same slug, different endpoint.
		expect(out).toEqual([
			{ endpointId: 'a', slug: 'm' },
			{ endpointId: 'b', slug: 'm' },
		]);
	});
});

describe('DEFAULT_MODEL / DEFAULT_MODEL_LIST', () => {
	it('the default is in the default list', () => {
		expect(DEFAULT_MODEL_LIST).toContain(DEFAULT_MODEL);
	});
});
