import { describe, expect, it } from 'vitest';
import {
	createInMemoryKeyStore,
	createLocalStorageKeyStore,
} from '../src/api-key-store';

describe('createInMemoryKeyStore', () => {
	it('returns empty string for an unset endpoint', () => {
		const s = createInMemoryKeyStore();
		expect(s.get('e1')).toBe('');
		expect(s.has('e1')).toBe(false);
	});

	it('stores and retrieves a key', () => {
		const s = createInMemoryKeyStore();
		s.set('e1', 'sk-abc');
		expect(s.get('e1')).toBe('sk-abc');
		expect(s.has('e1')).toBe(true);
	});

	it('accepts an initial seed', () => {
		const s = createInMemoryKeyStore({ e1: 'sk-seed' });
		expect(s.get('e1')).toBe('sk-seed');
	});

	it('set with empty string removes the key', () => {
		const s = createInMemoryKeyStore({ e1: 'sk-abc' });
		s.set('e1', '');
		expect(s.has('e1')).toBe(false);
		expect(s.get('e1')).toBe('');
	});

	it('clear() wipes every stored key', () => {
		const s = createInMemoryKeyStore({ e1: 'sk-a', e2: 'sk-b' });
		s.clear();
		expect(s.has('e1')).toBe(false);
		expect(s.has('e2')).toBe(false);
	});
});

function fakeStorage(initial: Record<string, string> = {}): Storage {
	const data = new Map<string, string>(Object.entries(initial));
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => (data.has(k) ? data.get(k)! : null),
		key: (i) => Array.from(data.keys())[i] ?? null,
		removeItem: (k) => {
			data.delete(k);
		},
		setItem: (k, v) => {
			data.set(k, String(v));
		},
	};
}

describe('createLocalStorageKeyStore', () => {
	it('writes under the given prefix', () => {
		const ls = fakeStorage();
		const s = createLocalStorageKeyStore('vk:apikey:', ls);
		s.set('e1', 'sk-abc');
		expect(ls.getItem('vk:apikey:e1')).toBe('sk-abc');
	});

	it('reads back what it wrote', () => {
		const ls = fakeStorage();
		const s = createLocalStorageKeyStore('vk:apikey:', ls);
		s.set('e1', 'sk-abc');
		expect(s.get('e1')).toBe('sk-abc');
		expect(s.has('e1')).toBe(true);
	});

	it('returns empty string for an unset endpoint', () => {
		const ls = fakeStorage();
		const s = createLocalStorageKeyStore('vk:apikey:', ls);
		expect(s.get('e1')).toBe('');
		expect(s.has('e1')).toBe(false);
	});

	it('set with empty string removes the key', () => {
		const ls = fakeStorage({ 'vk:apikey:e1': 'sk-abc' });
		const s = createLocalStorageKeyStore('vk:apikey:', ls);
		s.set('e1', '');
		expect(s.has('e1')).toBe(false);
		expect(ls.getItem('vk:apikey:e1')).toBeNull();
	});

	it('clear() removes every key under the prefix and leaves others alone', () => {
		const ls = fakeStorage({
			'vk:apikey:e1': 'sk-a',
			'vk:apikey:e2': 'sk-b',
			'other:key': 'untouched',
		});
		const s = createLocalStorageKeyStore('vk:apikey:', ls);
		s.clear();
		expect(ls.getItem('vk:apikey:e1')).toBeNull();
		expect(ls.getItem('vk:apikey:e2')).toBeNull();
		expect(ls.getItem('other:key')).toBe('untouched');
	});

	it('swallows storage errors (quota exceeded, disabled) — returns gracefully', () => {
		const broken: Storage = {
			get length() {
				return 0;
			},
			clear: () => {},
			getItem: () => null,
			key: () => null,
			removeItem: () => {
				throw new Error('storage disabled');
			},
			setItem: () => {
				throw new Error('quota exceeded');
			},
		};
		const s = createLocalStorageKeyStore('vk:apikey:', broken);
		expect(() => s.set('e1', 'sk-abc')).not.toThrow();
		expect(() => s.set('e1', '')).not.toThrow();
	});
});
