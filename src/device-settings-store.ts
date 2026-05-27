/**
 * Per-device settings blob — providers, favorites, default model, safety
 * toggles. Lives OUTSIDE `data.json` so Obsidian Sync can't ship desktop's
 * provider list (or favorites, or cost cap) to mobile, where the user may
 * want a completely different setup.
 *
 * Sibling to api-key-store. Keys remain in the api-key store keyed by
 * endpoint id; everything else fits into one blob keyed by the constant
 * below. The localStorage backend is per-device on both desktop (Electron)
 * and mobile (WKWebView / Android WebView).
 */

import type { ModelRef, Endpoint } from './types';

export interface DeviceSettings {
	endpoints: Endpoint[];
	favoriteModels: ModelRef[];
	defaultModelRef: ModelRef;
	titleModelRef: ModelRef;
	autoApproveWrites: boolean;
	costCapPerTurnUsd: number;
	anthropicPromptCaching: boolean;
}

export interface DeviceSettingsStore {
	get(): DeviceSettings | null;
	set(value: DeviceSettings): void;
	has(): boolean;
}

export const DEVICE_SETTINGS_STORE_KEY = 'vk:device-settings';

export function createInMemoryDeviceStore(initial?: DeviceSettings | null): DeviceSettingsStore {
	let stored: DeviceSettings | null = initial ?? null;
	return {
		get: () => stored,
		has: () => stored !== null,
		set: (value) => {
			stored = value;
		},
	};
}

export function createLocalStorageDeviceStore(key: string, ls?: Storage): DeviceSettingsStore {
	const storage = ls ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
	if (!storage) return createInMemoryDeviceStore();
	return {
		get: () => {
			try {
				const raw = storage.getItem(key);
				if (!raw) return null;
				const parsed = JSON.parse(raw) as Partial<DeviceSettings>;
				if (!parsed || typeof parsed !== 'object') return null;
				return parsed as DeviceSettings;
			} catch {
				return null;
			}
		},
		has: () => {
			try {
				return storage.getItem(key) !== null;
			} catch {
				return false;
			}
		},
		set: (value) => {
			try {
				storage.setItem(key, JSON.stringify(value));
			} catch {
				// Quota / disabled — the in-memory plugin.settings copy still
				// works for this session; we lose persistence only.
			}
		},
	};
}
