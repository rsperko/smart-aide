import { describe, expect, it } from 'vitest';
import {
	captureDeviceSettingsToStore,
	hydrateDeviceSettingsFromStore,
	stripDeviceSettingsForPersistence,
	DEFAULT_SETTINGS,
} from '../src/settings';
import {
	createInMemoryDeviceStore,
	createLocalStorageDeviceStore,
	DEVICE_SETTINGS_STORE_KEY,
	DeviceSettings,
} from '../src/device-settings-store';
import type { Endpoint, ModelRef } from '../src/types';

function makeEndpoint(id: string, key = ''): Endpoint {
	return { id, name: `Provider ${id}`, baseURL: `https://${id}.example.com`, apiKey: key };
}

function makeRef(endpointId: string, slug: string): ModelRef {
	return { endpointId, slug };
}

describe('hydrateDeviceSettingsFromStore', () => {
	it('resolves to per-device defaults when the store is empty (fresh device)', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			endpoints: [makeEndpoint('e1', 'k')],
			favoriteModels: [makeRef('e1', 'm-a')],
			autoApproveWrites: true,
			costCapPerTurnUsd: 0.25,
		};
		const store = createInMemoryDeviceStore();
		const out = hydrateDeviceSettingsFromStore(settings, store);
		// Even if data.json carried per-device fields (e.g. from a previous
		// install on this device), the device store is authoritative — empty
		// store means empty providers, no favorites, safety toggles off.
		expect(out.endpoints).toEqual([]);
		expect(out.favoriteModels).toEqual([]);
		expect(out.autoApproveWrites).toBe(false);
		expect(out.costCapPerTurnUsd).toBe(0);
		expect(out.anthropicPromptCaching).toBe(true);
	});

	it('replaces per-device fields from the store when populated', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			endpoints: [makeEndpoint('from-data-json')],
			favoriteModels: [makeRef('from-data-json', 'x')],
			autoApproveWrites: true,
			costCapPerTurnUsd: 1.0,
		};
		const stored: DeviceSettings = {
			endpoints: [makeEndpoint('from-store')],
			favoriteModels: [makeRef('from-store', 'y')],
			defaultModelRef: makeRef('from-store', 'y'),
			titleModelRef: makeRef('from-store', 'y'),
			autoApproveWrites: false,
			costCapPerTurnUsd: 0,
			anthropicPromptCaching: false,
		};
		const store = createInMemoryDeviceStore(stored);
		const out = hydrateDeviceSettingsFromStore(settings, store);
		expect(out.endpoints[0].id).toBe('from-store');
		expect(out.favoriteModels[0].endpointId).toBe('from-store');
		expect(out.defaultModelRef).toEqual(stored.defaultModelRef);
		expect(out.titleModelRef).toEqual(stored.titleModelRef);
		expect(out.autoApproveWrites).toBe(false);
		expect(out.costCapPerTurnUsd).toBe(0);
		expect(out.anthropicPromptCaching).toBe(false);
	});

	it('keeps vault-scoped fields (metaDir, systemPrompt) untouched', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			metaDir: 'sys',
			systemPrompt: 'custom prompt',
		};
		const stored: DeviceSettings = {
			endpoints: [],
			favoriteModels: [],
			defaultModelRef: makeRef('x', 'y'),
			titleModelRef: makeRef('x', 'y'),
			autoApproveWrites: false,
			costCapPerTurnUsd: 0,
			anthropicPromptCaching: true,
		};
		const store = createInMemoryDeviceStore(stored);
		const out = hydrateDeviceSettingsFromStore(settings, store);
		expect(out.metaDir).toBe('sys');
		expect(out.systemPrompt).toBe('custom prompt');
	});
});

describe('captureDeviceSettingsToStore', () => {
	it('writes the current per-device fields with apiKey blanked on endpoints', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			endpoints: [makeEndpoint('e1', 'SECRET'), makeEndpoint('e2', 'ALSO-SECRET')],
			favoriteModels: [makeRef('e1', 'm')],
			autoApproveWrites: true,
			costCapPerTurnUsd: 0.5,
		};
		const store = createInMemoryDeviceStore();
		captureDeviceSettingsToStore(settings, store);
		const stored = store.get();
		expect(stored).not.toBeNull();
		expect(stored!.endpoints).toHaveLength(2);
		expect(stored!.endpoints.every((e) => e.apiKey === '')).toBe(true);
		expect(stored!.favoriteModels).toEqual([makeRef('e1', 'm')]);
		expect(stored!.autoApproveWrites).toBe(true);
		expect(stored!.costCapPerTurnUsd).toBe(0.5);
	});
});

describe('stripDeviceSettingsForPersistence', () => {
	it('zeros out per-device fields so the synced data.json carries nothing device-specific', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			endpoints: [makeEndpoint('e1', 'SECRET')],
			favoriteModels: [makeRef('e1', 'm')],
			autoApproveWrites: true,
			costCapPerTurnUsd: 0.25,
			anthropicPromptCaching: false,
		};
		const out = stripDeviceSettingsForPersistence(settings);
		expect(out.endpoints).toEqual([]);
		expect(out.favoriteModels).toEqual([]);
		expect(out.autoApproveWrites).toBe(false);
		expect(out.costCapPerTurnUsd).toBe(0);
		expect(out.anthropicPromptCaching).toBe(true);
		// Stripped refs go to the unbound sentinel — not a fake OpenRouter ref.
		// A fresh peer device pulling this data.json gets a clean "pick a model"
		// state rather than inheriting a slug shape that may not match its setup.
		expect(out.defaultModelRef).toEqual({ endpointId: '', slug: '' });
		expect(out.titleModelRef).toEqual({ endpointId: '', slug: '' });
	});

	it('preserves vault-scoped settings (metaDir, systemPrompt, hasSeenMentionTip)', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			metaDir: 'sys',
			systemPrompt: 'custom',
			hasSeenMentionTip: true,
		};
		const out = stripDeviceSettingsForPersistence(settings);
		expect(out.metaDir).toBe('sys');
		expect(out.systemPrompt).toBe('custom');
		expect(out.hasSeenMentionTip).toBe(true);
	});
});

describe('createLocalStorageDeviceStore', () => {
	function fakeStorage(): Storage {
		const map = new Map<string, string>();
		return {
			get length() {
				return map.size;
			},
			clear: () => map.clear(),
			getItem: (k) => (map.has(k) ? map.get(k)! : null),
			key: (i) => Array.from(map.keys())[i] ?? null,
			removeItem: (k) => {
				map.delete(k);
			},
			setItem: (k, v) => {
				map.set(k, String(v));
			},
		} as Storage;
	}

	it('persists + reads back through JSON round-trip', () => {
		const ls = fakeStorage();
		const store = createLocalStorageDeviceStore(DEVICE_SETTINGS_STORE_KEY, ls);
		expect(store.has()).toBe(false);
		expect(store.get()).toBeNull();

		const value: DeviceSettings = {
			endpoints: [makeEndpoint('e1')],
			favoriteModels: [makeRef('e1', 'm')],
			defaultModelRef: makeRef('e1', 'm'),
			titleModelRef: makeRef('e1', 'm'),
			autoApproveWrites: true,
			costCapPerTurnUsd: 0.1,
			anthropicPromptCaching: false,
		};
		store.set(value);
		expect(store.has()).toBe(true);
		const got = store.get();
		expect(got?.endpoints[0].id).toBe('e1');
		expect(got?.autoApproveWrites).toBe(true);
		expect(got?.costCapPerTurnUsd).toBe(0.1);
	});

	it('returns null on malformed JSON', () => {
		const ls = fakeStorage();
		ls.setItem(DEVICE_SETTINGS_STORE_KEY, '{not json');
		const store = createLocalStorageDeviceStore(DEVICE_SETTINGS_STORE_KEY, ls);
		expect(store.get()).toBeNull();
	});
});
