import { describe, expect, it } from 'vitest';
import {
	captureApiKeysToStore,
	hydrateApiKeysFromStore,
	stripApiKeysForPersistence,
} from '../src/settings';
import { createInMemoryKeyStore } from '../src/api-key-store';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { Endpoint } from '../src/types';

function settingsWith(endpoints: Endpoint[]) {
	return { ...DEFAULT_SETTINGS, endpoints };
}

describe('hydrateApiKeysFromStore', () => {
	it('overrides endpoint.apiKey with the value from the store', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: 'OLD' },
		]);
		const store = createInMemoryKeyStore({ e1: 'NEW' });
		const out = hydrateApiKeysFromStore(settings, store);
		expect(out.endpoints[0].apiKey).toBe('NEW');
	});

	it('preserves endpoint.apiKey when the store has no entry (acts as one-shot migration source)', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: 'FROM_DATA_JSON' },
		]);
		const store = createInMemoryKeyStore();
		const out = hydrateApiKeysFromStore(settings, store);
		expect(out.endpoints[0].apiKey).toBe('FROM_DATA_JSON');
	});

	it('returns a new settings object (does not mutate input)', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: '' },
		]);
		const store = createInMemoryKeyStore({ e1: 'NEW' });
		const out = hydrateApiKeysFromStore(settings, store);
		expect(out).not.toBe(settings);
		expect(out.endpoints).not.toBe(settings.endpoints);
		expect(settings.endpoints[0].apiKey).toBe('');
	});

	it('handles a settings object with no endpoints', () => {
		const settings = { ...DEFAULT_SETTINGS, endpoints: [] };
		const store = createInMemoryKeyStore();
		const out = hydrateApiKeysFromStore(settings, store);
		expect(out.endpoints).toEqual([]);
	});
});

describe('captureApiKeysToStore', () => {
	it('writes each non-empty endpoint key to the store', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: 'KEY-A' },
			{ id: 'e2', name: 'B', baseURL: 'http://y', apiKey: 'KEY-B' },
		]);
		const store = createInMemoryKeyStore();
		captureApiKeysToStore(settings, store);
		expect(store.get('e1')).toBe('KEY-A');
		expect(store.get('e2')).toBe('KEY-B');
	});

	it('clears the store entry when endpoint.apiKey is empty', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: '' },
		]);
		const store = createInMemoryKeyStore({ e1: 'OLD' });
		captureApiKeysToStore(settings, store);
		expect(store.has('e1')).toBe(false);
	});
});

describe('stripApiKeysForPersistence', () => {
	it('returns a deep copy with every endpoint.apiKey blanked', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: 'SECRET-A' },
			{ id: 'e2', name: 'B', baseURL: 'http://y', apiKey: 'SECRET-B' },
		]);
		const out = stripApiKeysForPersistence(settings);
		expect(out.endpoints[0].apiKey).toBe('');
		expect(out.endpoints[1].apiKey).toBe('');
	});

	it('does not mutate the input settings', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: 'SECRET' },
		]);
		stripApiKeysForPersistence(settings);
		expect(settings.endpoints[0].apiKey).toBe('SECRET');
	});

	it('preserves all non-secret endpoint fields', () => {
		const settings = settingsWith([
			{
				id: 'e1',
				name: 'A',
				baseURL: 'http://x',
				apiKey: 'SECRET',
				headers: { 'X-Custom': 'v' },
				models: ['m1'],
				discoveredModels: [{ id: 'm1' }],
			},
		]);
		const out = stripApiKeysForPersistence(settings);
		expect(out.endpoints[0].name).toBe('A');
		expect(out.endpoints[0].baseURL).toBe('http://x');
		expect(out.endpoints[0].headers).toEqual({ 'X-Custom': 'v' });
		expect(out.endpoints[0].models).toEqual(['m1']);
		expect(out.endpoints[0].discoveredModels).toEqual([{ id: 'm1' }]);
	});
});

describe('migration round-trip', () => {
	it('typical first-load-after-upgrade: hydrate finds nothing → keeps data.json key → capture moves to store → strip clears for next save', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: 'LEGACY' },
		]);
		const store = createInMemoryKeyStore();

		const hydrated = hydrateApiKeysFromStore(settings, store);
		expect(hydrated.endpoints[0].apiKey).toBe('LEGACY');

		captureApiKeysToStore(hydrated, store);
		expect(store.get('e1')).toBe('LEGACY');

		const persistable = stripApiKeysForPersistence(hydrated);
		expect(persistable.endpoints[0].apiKey).toBe('');
	});

	it('second-device load: data.json has empty key (synced from device A) → hydrate finds nothing → endpoint stays empty', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: '' },
		]);
		const store = createInMemoryKeyStore();
		const hydrated = hydrateApiKeysFromStore(settings, store);
		expect(hydrated.endpoints[0].apiKey).toBe('');
	});

	it('second-device after user enters a key locally: store has key → hydrate populates it; the synced data.json with empty key cannot clobber', () => {
		const settings = settingsWith([
			{ id: 'e1', name: 'A', baseURL: 'http://x', apiKey: '' },
		]);
		const store = createInMemoryKeyStore({ e1: 'LOCAL-KEY' });
		const hydrated = hydrateApiKeysFromStore(settings, store);
		expect(hydrated.endpoints[0].apiKey).toBe('LOCAL-KEY');
	});
});
