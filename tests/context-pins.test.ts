import { beforeEach, describe, expect, it } from 'vitest';
import { App, TFile, Vault } from 'obsidian';
import { PinnedContext } from '../src/context-pins';

class MiniVault extends Vault {
	files = new Map<string, string>();
	getFileByPath(path: string): TFile | null {
		if (!this.files.has(path)) return null;
		const f = new TFile();
		f.path = path;
		f.extension = 'md';
		return f;
	}
	async cachedRead(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? '';
	}
}

function makeApp(files: Record<string, string>): App {
	const vault = new MiniVault();
	for (const [p, c] of Object.entries(files)) vault.files.set(p, c);
	const app = new App();
	app.vault = vault as unknown as Vault;
	return app;
}

describe('PinnedContext list/add/remove/clear', () => {
	it('adds, dedupes, removes, and clears', () => {
		const pins = new PinnedContext(makeApp({}));
		pins.add('a.md');
		pins.add('a.md');
		pins.add('b.md');
		expect(pins.list()).toEqual(['a.md', 'b.md']);
		expect(pins.has('a.md')).toBe(true);
		pins.remove('a.md');
		expect(pins.list()).toEqual(['b.md']);
		pins.clear();
		expect(pins.list()).toEqual([]);
	});
});

describe('PinnedContext.statusOf', () => {
	it('returns null for a missing file', async () => {
		const pins = new PinnedContext(makeApp({}));
		expect(await pins.statusOf('nope.md')).toBeNull();
	});

	it('reports under-cap files with truncated=false', async () => {
		const pins = new PinnedContext(makeApp({ 'a.md': 'hello' }));
		const s = await pins.statusOf('a.md');
		expect(s).not.toBeNull();
		expect(s!.truncated).toBe(false);
		expect(s!.sentBytes).toBe(5);
		expect(s!.totalBytes).toBe(5);
		expect(s!.tokens).toBe(2); // ceil(5/4)
	});

	it('reports over-cap files with truncated=true and sentBytes==cap', async () => {
		const large = 'x'.repeat(PinnedContext.MAX_BYTES_PER_FILE + 100);
		const pins = new PinnedContext(makeApp({ 'big.md': large }));
		const s = await pins.statusOf('big.md');
		expect(s!.truncated).toBe(true);
		expect(s!.sentBytes).toBe(PinnedContext.MAX_BYTES_PER_FILE);
		expect(s!.totalBytes).toBe(large.length);
	});

	it('estimateTokens uses statusOf under the hood', async () => {
		const pins = new PinnedContext(makeApp({ 'a.md': 'hello' }));
		expect(await pins.estimateTokens('a.md')).toBe(2);
		expect(await pins.estimateTokens('missing.md')).toBe(0);
	});
});

describe('PinnedContext.buildPreamble', () => {
	let pins: PinnedContext;
	beforeEach(() => {
		pins = new PinnedContext(makeApp({ 'a.md': 'A content', 'b.md': 'B content' }));
	});

	it('returns empty when nothing pinned', async () => {
		expect(await pins.buildPreamble()).toBe('');
	});

	it('joins multiple files with a `---` separator', async () => {
		pins.add('a.md');
		pins.add('b.md');
		const out = await pins.buildPreamble();
		expect(out).toContain('File: a.md');
		expect(out).toContain('File: b.md');
		expect(out).toContain('---');
	});

	it('inlines small files in full', async () => {
		pins.add('a.md');
		const out = await pins.buildPreamble();
		expect(out).toContain('A content');
		expect(out).not.toContain('…(truncated');
	});

	it('truncates and appends the cap marker for large files', async () => {
		const large = 'x'.repeat(PinnedContext.MAX_BYTES_PER_FILE + 500);
		const pins2 = new PinnedContext(makeApp({ 'big.md': large }));
		pins2.add('big.md');
		const out = await pins2.buildPreamble();
		expect(out).toContain('…(truncated');
		expect(out).toContain('use read_note for more');
	});

	it('skips missing files but still emits a preamble for the rest', async () => {
		pins.add('a.md');
		pins.add('missing.md');
		const out = await pins.buildPreamble();
		expect(out).toContain('File: a.md');
		expect(out).not.toContain('missing.md');
	});

	it('returns empty when every pinned path is missing', async () => {
		pins.add('missing1.md');
		pins.add('missing2.md');
		expect(await pins.buildPreamble()).toBe('');
	});
});
