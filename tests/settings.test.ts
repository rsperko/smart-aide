import { describe, expect, it } from 'vitest';
import {
	DEFAULT_META_DIR,
	DEFAULT_SETTINGS,
	DEFAULT_SYSTEM_PROMPT,
	OPENROUTER_ID,
	chatsDirFor,
	defaultOpenRouterEndpoint,
	describeFreshness,
	describeModelRef,
	endpointModelCount,
	endpointSummary,
	findEndpoint,
	internalDirFor,
	isEndpointConnected,
	migrateSettings,
	newEndpointId,
	normalizeMetaDir,
	pickReplacementModelRef,
	previewSystemPrompt,
	resolveModelRef,
	sameRef,
	skillsDirFor,
} from '../src/settings';
import type { SmartAideSettings } from '../src/settings';
import type { Endpoint } from '../src/types';

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

	it('drops legacy recents entries that are neither strings nor ModelRef objects', () => {
		const out = migrateSettings({
			apiKey: 'k',
			// Mixed: valid string, valid ref, and two invalid shapes that should be filtered out.
			modelRecents: ['valid-slug', { endpointId: 'openrouter', slug: 'also-valid' }, 42, null],
		});
		expect(out.modelRecents).toHaveLength(2);
		expect(out.modelRecents.map((r) => r.slug)).toEqual(['valid-slug', 'also-valid']);
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

describe('defaultOpenRouterEndpoint', () => {
	it('returns OpenRouter shape with default model list when none provided', () => {
		const e = defaultOpenRouterEndpoint();
		expect(e.id).toBe(OPENROUTER_ID);
		expect(e.name).toBe('OpenRouter');
		expect(e.baseURL).toBe('https://openrouter.ai/api/v1');
		expect(e.apiKey).toBe('');
		expect((e.models ?? []).length).toBeGreaterThan(0);
	});

	it('uses the provided models list when non-empty', () => {
		const e = defaultOpenRouterEndpoint('key', ['only/one']);
		expect(e.apiKey).toBe('key');
		expect(e.models).toEqual(['only/one']);
	});

	it('falls back to defaults when models is empty array', () => {
		const e = defaultOpenRouterEndpoint('key', []);
		expect((e.models ?? []).length).toBeGreaterThan(0);
	});
});

describe('findEndpoint', () => {
	it('returns the endpoint by id', () => {
		const e = findEndpoint(DEFAULT_SETTINGS, OPENROUTER_ID);
		expect(e?.id).toBe(OPENROUTER_ID);
	});

	it('returns undefined when the id does not exist', () => {
		expect(findEndpoint(DEFAULT_SETTINGS, 'nope')).toBeUndefined();
	});
});

describe('endpointModelCount + isEndpointConnected', () => {
	it('counts manual models alone', () => {
		const e: Endpoint = { id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['a', 'b'] };
		expect(endpointModelCount(e)).toBe(2);
		expect(isEndpointConnected(e)).toBe(true);
	});

	it('merges manual + discovered without double-counting', () => {
		const e: Endpoint = {
			id: 'x', name: 'X', baseURL: '', apiKey: 'k',
			models: ['a', 'b'],
			discoveredModels: [{ id: 'b' }, { id: 'c' }],
		};
		expect(endpointModelCount(e)).toBe(3);
	});

	it('reports zero when both lists are empty', () => {
		const e: Endpoint = { id: 'x', name: 'X', baseURL: '', apiKey: 'k' };
		expect(endpointModelCount(e)).toBe(0);
	});

	it('isEndpointConnected requires key AND at least one model', () => {
		expect(isEndpointConnected({ id: 'x', name: 'X', baseURL: '', apiKey: '', models: ['a'] })).toBe(false);
		expect(isEndpointConnected({ id: 'x', name: 'X', baseURL: '', apiKey: 'k' })).toBe(false);
		expect(isEndpointConnected({ id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['a'] })).toBe(true);
	});
});

describe('endpointSummary', () => {
	it('reports "no key" when apiKey is missing', () => {
		expect(endpointSummary({ id: 'x', name: 'X', baseURL: '', apiKey: '' })).toBe('no key');
	});

	it('singularizes "1 model" and pluralizes otherwise', () => {
		const one: Endpoint = { id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m'] };
		const two: Endpoint = { id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m', 'n'] };
		expect(endpointSummary(one)).toMatch(/^1 model/);
		expect(endpointSummary(two)).toMatch(/^2 models/);
	});

	it('includes a "✓ tested" segment when lastTest.ok is true', () => {
		const e: Endpoint = {
			id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m'],
			lastTest: { ok: true, at: new Date().toISOString() },
		};
		expect(endpointSummary(e)).toMatch(/✓ tested/);
	});

	it('includes a "✗ <message>" segment when lastTest.ok is false', () => {
		const e: Endpoint = {
			id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m'],
			lastTest: { ok: false, at: new Date().toISOString(), message: 'auth failed' },
		};
		expect(endpointSummary(e)).toMatch(/✗ auth failed/);
	});

	it('falls back to a generic "test failed" when no message is given', () => {
		const e: Endpoint = {
			id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m'],
			lastTest: { ok: false, at: new Date().toISOString() },
		};
		expect(endpointSummary(e)).toMatch(/✗ test failed/);
	});

	it('shows "refreshed ..." when no lastTest but a discoveredAt exists', () => {
		const e: Endpoint = {
			id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m'],
			discoveredAt: new Date().toISOString(),
		};
		expect(endpointSummary(e)).toMatch(/refreshed/);
	});

	it('shows "not refreshed" when neither lastTest nor discoveredAt exist', () => {
		const e: Endpoint = { id: 'x', name: 'X', baseURL: '', apiKey: 'k', models: ['m'] };
		expect(endpointSummary(e)).toMatch(/not refreshed/);
	});
});

describe('newEndpointId', () => {
	it('returns endpoint-1 when none exist', () => {
		expect(newEndpointId([])).toBe('endpoint-1');
	});

	it('skips taken ids', () => {
		const existing: Endpoint[] = [
			{ id: 'endpoint-1', name: 'a', baseURL: '', apiKey: '' },
			{ id: 'endpoint-2', name: 'b', baseURL: '', apiKey: '' },
		];
		expect(newEndpointId(existing)).toBe('endpoint-3');
	});

	it('ignores non-conflicting ids', () => {
		const existing: Endpoint[] = [
			{ id: 'openrouter', name: 'o', baseURL: '', apiKey: '' },
		];
		expect(newEndpointId(existing)).toBe('endpoint-1');
	});
});

describe('pickReplacementModelRef', () => {
	it('picks the first model of the first endpoint', () => {
		const settings = {
			endpoints: [
				{ id: 'a', name: 'A', baseURL: '', apiKey: '', models: ['first', 'second'] },
				{ id: 'b', name: 'B', baseURL: '', apiKey: '' },
			],
		} as unknown as SmartAideSettings;
		expect(pickReplacementModelRef(settings, 'b')).toEqual({ endpointId: 'a', slug: 'first' });
	});

	it('falls back to discoveredModels[0] when no manual models', () => {
		const settings = {
			endpoints: [
				{ id: 'a', name: 'A', baseURL: '', apiKey: '', discoveredModels: [{ id: 'disc' }] },
			],
		} as unknown as SmartAideSettings;
		expect(pickReplacementModelRef(settings, 'x').slug).toBe('disc');
	});

	it('falls back to OpenRouter id + DEFAULT_MODEL when no endpoints', () => {
		const settings = { endpoints: [] } as unknown as SmartAideSettings;
		const out = pickReplacementModelRef(settings, 'x');
		expect(out.endpointId).toBe(OPENROUTER_ID);
		expect(out.slug).toBeTruthy();
	});
});

describe('describeModelRef', () => {
	it('returns just the friendly name when only one endpoint exists', () => {
		const settings = {
			endpoints: [{ id: 'a', name: 'A', baseURL: '', apiKey: '' }],
		} as unknown as SmartAideSettings;
		expect(describeModelRef(settings, { endpointId: 'a', slug: 'anthropic/claude-haiku-4.5' })).not.toMatch(/·/);
	});

	it('appends endpoint name when multiple endpoints exist', () => {
		const settings = {
			endpoints: [
				{ id: 'a', name: 'A', baseURL: '', apiKey: '' },
				{ id: 'b', name: 'Work', baseURL: '', apiKey: '' },
			],
		} as unknown as SmartAideSettings;
		expect(describeModelRef(settings, { endpointId: 'b', slug: 'x' })).toMatch(/· Work$/);
	});

	it('falls back to the endpoint id when the endpoint is missing', () => {
		const settings = {
			endpoints: [
				{ id: 'a', name: 'A', baseURL: '', apiKey: '' },
				{ id: 'b', name: 'B', baseURL: '', apiKey: '' },
			],
		} as unknown as SmartAideSettings;
		expect(describeModelRef(settings, { endpointId: 'missing', slug: 'x' })).toMatch(/· missing$/);
	});
});

describe('previewSystemPrompt', () => {
	it('flattens whitespace into single spaces', () => {
		expect(previewSystemPrompt('a\n\n  b\tc')).toBe('a b c');
	});

	it('truncates with ellipsis past 120 chars', () => {
		const long = 'x'.repeat(200);
		const out = previewSystemPrompt(long);
		expect(out.length).toBe(118);
		expect(out.endsWith('…')).toBe(true);
	});

	it('leaves the default system prompt round-trippable as a flat preview', () => {
		const out = previewSystemPrompt(DEFAULT_SYSTEM_PROMPT);
		expect(out.length).toBeLessThanOrEqual(118);
	});
});
