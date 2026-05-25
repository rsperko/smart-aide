import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_MODEL_LIST, friendlyModelName } from '../src/models';

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

describe('DEFAULT_MODEL / DEFAULT_MODEL_LIST', () => {
	it('the default is in the default list', () => {
		expect(DEFAULT_MODEL_LIST).toContain(DEFAULT_MODEL);
	});
});
