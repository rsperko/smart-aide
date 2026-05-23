import { describe, expect, it } from 'vitest';
import {
	DEFAULT_META_DIR,
	describeFreshness,
	migrateSettings,
	normalizeMetaDir,
	resolveModelRef,
	sameRef,
	chatsDirFor,
	skillsDirFor,
	internalDirFor,
} from '../src/settings';

describe('normalizeMetaDir', () => {
	it('strips leading and trailing slashes and collapses repeats', () => {
		expect(normalizeMetaDir('sys/')).toBe('sys');
		expect(normalizeMetaDir('/sys')).toBe('sys');
		expect(normalizeMetaDir('//foo//bar//')).toBe('foo/bar');
	});

	it('falls back to default on empty / whitespace / null', () => {
		expect(normalizeMetaDir('')).toBe(DEFAULT_META_DIR);
		expect(normalizeMetaDir('   ')).toBe(DEFAULT_META_DIR);
		expect(normalizeMetaDir('/')).toBe(DEFAULT_META_DIR);
	});

	it('preserves multi-segment paths', () => {
		expect(normalizeMetaDir('plugins/smart-aide')).toBe('plugins/smart-aide');
	});
});

describe('migrateSettings', () => {
	it('takes the multi-endpoint path when endpoints array is present', () => {
		const out = migrateSettings({
			endpoints: [{ id: 'e1', name: 'X', baseURL: 'u', apiKey: 'k' }],
			defaultModelRef: { endpointId: 'e1', slug: 'm' },
			titleModelRef: { endpointId: 'e1', slug: 't' },
			modelRecents: [{ endpointId: 'e1', slug: 'm' }],
			systemPrompt: 'custom',
			autoApproveWrites: true,
			metaDir: 'sys/',
		});
		expect(out.endpoints[0].id).toBe('e1');
		expect(out.autoApproveWrites).toBe(true);
		// metaDir runs through normalizeMetaDir during migration.
		expect(out.metaDir).toBe('sys');
		expect(out.systemPrompt).toBe('custom');
	});

	it('migrates legacy single-key shape into OpenRouter endpoint', () => {
		const out = migrateSettings({
			apiKey: 'sk-or-v1-legacy',
			defaultModel: 'anthropic/claude-haiku-4.5',
			titleModel: 'openai/gpt-4o-mini',
			modelRecents: ['anthropic/claude-haiku-4.5', { endpointId: 'openrouter', slug: 'x' }],
		});
		expect(out.endpoints).toHaveLength(1);
		expect(out.endpoints[0].id).toBe('openrouter');
		expect(out.endpoints[0].apiKey).toBe('sk-or-v1-legacy');
		expect(out.defaultModelRef).toEqual({ endpointId: 'openrouter', slug: 'anthropic/claude-haiku-4.5' });
		expect(out.titleModelRef).toEqual({ endpointId: 'openrouter', slug: 'openai/gpt-4o-mini' });
		expect(out.modelRecents).toHaveLength(2);
	});

	it('handles a fully empty input by giving defaults', () => {
		const out = migrateSettings(null);
		expect(out.endpoints).toHaveLength(1);
		expect(out.metaDir).toBe(DEFAULT_META_DIR);
	});
});

describe('describeFreshness', () => {
	it('returns "just now" within a minute', () => {
		const now = new Date().toISOString();
		expect(describeFreshness(now)).toBe('just now');
	});

	it('returns Xm ago within an hour', () => {
		const fiveAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		expect(describeFreshness(fiveAgo)).toBe('5m ago');
	});

	it('returns Xh ago within a day', () => {
		const threeAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		expect(describeFreshness(threeAgo)).toMatch(/^3h ago$/);
	});

	it('returns "yesterday" at 1 day', () => {
		const oneDay = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		expect(describeFreshness(oneDay)).toBe('yesterday');
	});

	it('returns Xd ago within a month', () => {
		const fiveDays = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		expect(describeFreshness(fiveDays)).toBe('5d ago');
	});

	it('returns iso date for older entries', () => {
		const old = '2025-01-15T10:00:00.000Z';
		expect(describeFreshness(old)).toBe('2025-01-15');
	});

	it('returns the raw input sliced to 10 chars for malformed dates', () => {
		expect(describeFreshness('garbage-input-string')).toBe('garbage-in');
	});
});

describe('sameRef', () => {
	it('matches on endpointId + slug', () => {
		expect(sameRef({ endpointId: 'a', slug: 'x' }, { endpointId: 'a', slug: 'x' })).toBe(true);
		expect(sameRef({ endpointId: 'a', slug: 'x' }, { endpointId: 'a', slug: 'y' })).toBe(false);
		expect(sameRef({ endpointId: 'a', slug: 'x' }, { endpointId: 'b', slug: 'x' })).toBe(false);
	});
});

describe('resolveModelRef', () => {
	it('returns the named endpoint when it exists', () => {
		const settings = {
			endpoints: [
				{ id: 'a', name: 'A', baseURL: '', apiKey: '' },
				{ id: 'b', name: 'B', baseURL: '', apiKey: '' },
			],
		} as never;
		const { endpoint, slug } = resolveModelRef(settings, { endpointId: 'b', slug: 'm' });
		expect(endpoint.id).toBe('b');
		expect(slug).toBe('m');
	});

	it('falls back to the first endpoint when the named one is missing', () => {
		const settings = { endpoints: [{ id: 'a', name: 'A', baseURL: '', apiKey: '' }] } as never;
		const { endpoint } = resolveModelRef(settings, { endpointId: 'missing', slug: 'm' });
		expect(endpoint.id).toBe('a');
	});
});

describe('derived meta paths', () => {
	it('compose chats/skills/internal under the metaDir', () => {
		expect(chatsDirFor('Meta')).toBe('Meta/chats');
		expect(skillsDirFor('sys')).toBe('sys/skills');
		expect(internalDirFor('plugins/aide')).toBe('plugins/aide/.smart-aide');
	});
});
