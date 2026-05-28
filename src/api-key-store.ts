/**
 * Per-device API key store. Keys live OUTSIDE `data.json` so Obsidian Sync
 * can't propagate them across devices and clobber one device's keys with
 * another's. The localStorage backend is per-device by definition and works on
 * both desktop (Electron) and mobile (WKWebView/Android WebView).
 *
 * The in-memory backend exists for tests and can be re-used as a one-shot
 * fallback if `localStorage` is unavailable for any reason.
 */

export interface ApiKeyStore {
	get(endpointId: string): string;
	set(endpointId: string, key: string): void;
	has(endpointId: string): boolean;
	clear(): void;
}

export function createInMemoryKeyStore(initial?: Record<string, string>): ApiKeyStore {
	const data = new Map<string, string>();
	if (initial) {
		for (const [k, v] of Object.entries(initial)) {
			if (v) data.set(k, v);
		}
	}
	return {
		get: (id) => data.get(id) ?? '',
		has: (id) => data.has(id),
		set: (id, key) => {
			if (key) data.set(id, key);
			else data.delete(id);
		},
		clear: () => data.clear(),
	};
}

export function createLocalStorageKeyStore(prefix: string, ls?: Storage): ApiKeyStore {
	const storage = ls ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
	if (!storage) return createInMemoryKeyStore();
	const k = (id: string) => `${prefix}${id}`;
	return {
		get: (id) => {
			try {
				return storage.getItem(k(id)) ?? '';
			} catch {
				return '';
			}
		},
		has: (id) => {
			try {
				return storage.getItem(k(id)) !== null;
			} catch {
				return false;
			}
		},
		set: (id, key) => {
			try {
				if (key) storage.setItem(k(id), key);
				else storage.removeItem(k(id));
			} catch {
				// Swallow quota/disabled errors — the in-memory endpoint.apiKey still
				// works for this session; nothing else depends on persistence here.
			}
		},
		clear: () => {
			try {
				const matches: string[] = [];
				for (let i = 0; i < storage.length; i++) {
					const name = storage.key(i);
					if (name && name.startsWith(prefix)) matches.push(name);
				}
				for (const name of matches) storage.removeItem(name);
			} catch {
				// Storage unavailable — nothing to clear.
			}
		},
	};
}

export const API_KEY_STORE_PREFIX = 'vk:apikey:';
