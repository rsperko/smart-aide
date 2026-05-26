import { beforeEach, describe, expect, it } from 'vitest';
import { App, TFile, Vault } from 'obsidian';
import { PinnedContext } from '../src/context-pins';

interface FileRecord {
	content: string;
	mtime: number;
	size: number;
}

class MiniVault extends Vault {
	files = new Map<string, FileRecord>();
	reads: string[] = [];
	getFileByPath(path: string): TFile | null {
		const rec = this.files.get(path);
		if (!rec) return null;
		const f = new TFile();
		f.path = path;
		f.extension = 'md';
		f.stat = { mtime: rec.mtime, ctime: 0, size: rec.size };
		return f;
	}
	async cachedRead(file: TFile): Promise<string> {
		this.reads.push(file.path);
		return this.files.get(file.path)?.content ?? '';
	}
}

function makeApp(files: Record<string, string>): App {
	const vault = new MiniVault();
	let i = 1;
	for (const [p, c] of Object.entries(files)) {
		vault.files.set(p, { content: c, mtime: i++, size: c.length });
	}
	const app = new App();
	app.vault = vault as unknown as Vault;
	return app;
}

function vaultOf(app: App): MiniVault {
	return app.vault as unknown as MiniVault;
}

describe('PinnedContext list/add/remove/clear', () => {
	it('adds, dedupes, removes, and clears file pins', () => {
		const pins = new PinnedContext(makeApp({}));
		pins.add('a.md');
		pins.add('a.md');
		pins.add('b.md');
		expect(pins.list().map((p) => p.key)).toEqual(['a.md', 'b.md']);
		expect(pins.has('a.md')).toBe(true);
		pins.remove('a.md');
		expect(pins.list().map((p) => p.key)).toEqual(['b.md']);
		pins.clear();
		expect(pins.list()).toEqual([]);
	});

	it('back-compat: add(path) is an alias for addFile(path)', () => {
		const pins = new PinnedContext(makeApp({}));
		pins.add('a.md');
		const list = pins.list();
		expect(list).toHaveLength(1);
		expect(list[0].type).toBe('file');
		expect(list[0].key).toBe('a.md');
	});

	it('adds a web URL pin with its content cached at pin time', () => {
		const pins = new PinnedContext(makeApp({}));
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/article',
			title: 'Example Article',
			content: 'Some body text.',
			byline: 'Author Name',
			fetchedAt: 1700000000000,
		});
		expect(pins.has('https://example.com/article')).toBe(true);
		const [pin] = pins.list();
		expect(pin.type).toBe('url');
		expect(pin.key).toBe('https://example.com/article');
	});

	it('adds a YouTube pin', () => {
		const pins = new PinnedContext(makeApp({}));
		pins.addYouTube({
			kind: 'youtube',
			url: 'https://www.youtube.com/watch?v=abc123',
			videoId: 'abc123',
			title: 'Video Title',
			channel: 'Channel Name',
			transcript: 'Hello\nWorld',
			fetchedAt: 1700000000000,
		});
		const [pin] = pins.list();
		expect(pin.type).toBe('youtube');
		expect(pin.key).toBe('https://www.youtube.com/watch?v=abc123');
	});

	it('mixes file + url + youtube pins in insertion order', () => {
		const pins = new PinnedContext(makeApp({ 'a.md': 'A' }));
		pins.add('a.md');
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/a',
			title: 'T',
			content: 'C',
			fetchedAt: 0,
		});
		pins.addYouTube({
			kind: 'youtube',
			url: 'https://youtu.be/abc',
			videoId: 'abc',
			title: 'V',
			channel: 'CH',
			transcript: 'X',
			fetchedAt: 0,
		});
		expect(pins.list().map((p) => p.type)).toEqual(['file', 'url', 'youtube']);
	});

	it('dedupes URL pins by URL', () => {
		const pins = new PinnedContext(makeApp({}));
		const extract = {
			kind: 'web' as const,
			url: 'https://example.com/a',
			title: 'T',
			content: 'C',
			fetchedAt: 0,
		};
		pins.addUrl(extract);
		pins.addUrl(extract);
		expect(pins.list()).toHaveLength(1);
	});

	it('remove(key) handles URL keys too', () => {
		const pins = new PinnedContext(makeApp({}));
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/a',
			title: 'T',
			content: 'C',
			fetchedAt: 0,
		});
		expect(pins.has('https://example.com/a')).toBe(true);
		pins.remove('https://example.com/a');
		expect(pins.has('https://example.com/a')).toBe(false);
	});
});

describe('PinnedContext.statusOf', () => {
	it('returns null for a key that is not pinned', async () => {
		const pins = new PinnedContext(makeApp({ 'nope.md': 'x' }));
		// Even with the file present in the vault, statusOf only resolves keys
		// for pins that have been added. statusOf is a per-pin reporter, not a
		// vault probe.
		expect(await pins.statusOf('nope.md')).toBeNull();
	});

	it('returns null when a pinned file has been deleted from the vault', async () => {
		const pins = new PinnedContext(makeApp({}));
		pins.add('gone.md');
		expect(await pins.statusOf('gone.md')).toBeNull();
	});

	it('reports under-cap files with truncated=false', async () => {
		const pins = new PinnedContext(makeApp({ 'a.md': 'hello' }));
		pins.add('a.md');
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
		pins.add('big.md');
		const s = await pins.statusOf('big.md');
		expect(s!.truncated).toBe(true);
		expect(s!.sentBytes).toBe(PinnedContext.MAX_BYTES_PER_FILE);
		expect(s!.totalBytes).toBe(large.length);
	});

	it('estimateTokens uses statusOf under the hood', async () => {
		const pins = new PinnedContext(makeApp({ 'a.md': 'hello' }));
		pins.add('a.md');
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

describe('PinnedContext stat-based caching', () => {
	it('does not re-read the file when stat (mtime + size) is unchanged', async () => {
		const app = makeApp({ 'a.md': 'A content' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');

		await pins.buildPreamble();
		await pins.statusOf('a.md');
		await pins.buildPreamble();

		// One read total: the first buildPreamble populated the cache; the
		// statusOf and second buildPreamble both hit the cache because mtime+size
		// haven't changed.
		expect(vault.reads.filter((p) => p === 'a.md')).toHaveLength(1);
	});

	it('re-reads when mtime advances (the model must see edits immediately)', async () => {
		const app = makeApp({ 'a.md': 'original' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');

		const first = await pins.buildPreamble();
		expect(first).toContain('original');

		vault.files.set('a.md', { content: 'edited', mtime: 999, size: 'edited'.length });
		const second = await pins.buildPreamble();
		expect(second).toContain('edited');
		expect(second).not.toContain('original');
		expect(vault.reads.filter((p) => p === 'a.md')).toHaveLength(2);
	});

	it('re-reads when size changes but mtime happens to stay the same', async () => {
		const app = makeApp({ 'a.md': 'short' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');

		await pins.buildPreamble();
		const originalMtime = vault.files.get('a.md')!.mtime;
		vault.files.set('a.md', { content: 'short plus more', mtime: originalMtime, size: 'short plus more'.length });

		const second = await pins.buildPreamble();
		expect(second).toContain('short plus more');
		expect(vault.reads.filter((p) => p === 'a.md')).toHaveLength(2);
	});

	it('statusOf reflects the current truncation state after a small file grows past the cap', async () => {
		const app = makeApp({ 'a.md': 'small' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');

		const before = await pins.statusOf('a.md');
		expect(before!.truncated).toBe(false);

		const huge = 'x'.repeat(PinnedContext.MAX_BYTES_PER_FILE + 100);
		vault.files.set('a.md', { content: huge, mtime: 999, size: huge.length });

		const after = await pins.statusOf('a.md');
		expect(after!.truncated).toBe(true);
		expect(after!.sentBytes).toBe(PinnedContext.MAX_BYTES_PER_FILE);
	});

	it('remove() evicts the cache so a re-added pin sees current content', async () => {
		const app = makeApp({ 'a.md': 'original' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');
		await pins.buildPreamble();

		pins.remove('a.md');
		vault.files.set('a.md', { content: 'edited-while-unpinned', mtime: 999, size: 'edited-while-unpinned'.length });

		pins.add('a.md');
		const out = await pins.buildPreamble();
		expect(out).toContain('edited-while-unpinned');
		// Two reads: initial pin + after re-pinning (would still be one if the
		// cache had survived removal, which would surface stale content).
		expect(vault.reads.filter((p) => p === 'a.md')).toHaveLength(2);
	});

	it('clear() evicts the cache for every pin', async () => {
		const app = makeApp({ 'a.md': 'original-a', 'b.md': 'original-b' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');
		pins.add('b.md');
		await pins.buildPreamble();

		pins.clear();
		vault.files.set('a.md', { content: 'fresh-a', mtime: 999, size: 'fresh-a'.length });

		pins.add('a.md');
		const out = await pins.buildPreamble();
		expect(out).toContain('fresh-a');
	});

	it('statusOf evicts a cached entry when the file disappears', async () => {
		const app = makeApp({ 'a.md': 'original' });
		const vault = vaultOf(app);
		const pins = new PinnedContext(app);
		pins.add('a.md');

		expect(await pins.statusOf('a.md')).not.toBeNull();

		vault.files.delete('a.md');
		expect(await pins.statusOf('a.md')).toBeNull();

		// Re-creating with new content must surface immediately rather than
		// serving the stale cached entry from before the deletion.
		vault.files.set('a.md', { content: 'recreated', mtime: 999, size: 'recreated'.length });
		const out = await pins.buildPreamble();
		expect(out).toContain('recreated');
	});
});

describe('PinnedContext URL pin status + preamble', () => {
	it('statusOf reports tokens + byte counts from the cached URL content', async () => {
		const pins = new PinnedContext(makeApp({}));
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/a',
			title: 'T',
			content: 'hello world',
			fetchedAt: 0,
		});
		const s = await pins.statusOf('https://example.com/a');
		expect(s).not.toBeNull();
		expect(s!.totalBytes).toBe(11);
		expect(s!.sentBytes).toBe(11);
		expect(s!.truncated).toBe(false);
		expect(s!.tokens).toBe(Math.ceil(11 / 4));
	});

	it('flags truncated=true for URL content over the cap', async () => {
		const huge = 'x'.repeat(PinnedContext.MAX_BYTES_PER_FILE + 100);
		const pins = new PinnedContext(makeApp({}));
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/big',
			title: 'Big',
			content: huge,
			fetchedAt: 0,
		});
		const s = await pins.statusOf('https://example.com/big');
		expect(s!.truncated).toBe(true);
		expect(s!.sentBytes).toBe(PinnedContext.MAX_BYTES_PER_FILE);
	});

	it('returns null for an unknown key', async () => {
		const pins = new PinnedContext(makeApp({}));
		expect(await pins.statusOf('https://nope.com')).toBeNull();
	});

	it('buildPreamble includes a Web page section with title + source', async () => {
		const pins = new PinnedContext(makeApp({}));
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/a',
			title: 'My Article',
			content: 'Article body here.',
			byline: 'Author X',
			fetchedAt: 0,
		});
		const out = await pins.buildPreamble();
		expect(out).toContain('Web page: My Article');
		expect(out).toContain('Source: https://example.com/a');
		expect(out).toContain('Byline: Author X');
		expect(out).toContain('Article body here.');
	});

	it('buildPreamble includes a YouTube section with channel + transcript', async () => {
		const pins = new PinnedContext(makeApp({}));
		pins.addYouTube({
			kind: 'youtube',
			url: 'https://www.youtube.com/watch?v=abc',
			videoId: 'abc',
			title: 'Video Title',
			channel: 'Channel Name',
			transcript: 'Spoken words here.',
			fetchedAt: 0,
		});
		const out = await pins.buildPreamble();
		expect(out).toContain('YouTube transcript: Video Title');
		expect(out).toContain('Channel: Channel Name');
		expect(out).toContain('Source: https://www.youtube.com/watch?v=abc');
		expect(out).toContain('Spoken words here.');
	});

	it('truncates oversized URL content in the preamble with a marker', async () => {
		const huge = 'x'.repeat(PinnedContext.MAX_BYTES_PER_FILE + 500);
		const pins = new PinnedContext(makeApp({}));
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/big',
			title: 'Big',
			content: huge,
			fetchedAt: 0,
		});
		const out = await pins.buildPreamble();
		expect(out).toContain('…(truncated');
		expect(out).toContain('visit the URL for the rest');
	});

	it('mixes file + URL + youtube sections in the preamble', async () => {
		const pins = new PinnedContext(makeApp({ 'a.md': 'file content' }));
		pins.add('a.md');
		pins.addUrl({
			kind: 'web',
			url: 'https://example.com/a',
			title: 'Web',
			content: 'web content',
			fetchedAt: 0,
		});
		pins.addYouTube({
			kind: 'youtube',
			url: 'https://www.youtube.com/watch?v=abc',
			videoId: 'abc',
			title: 'YT',
			channel: 'Ch',
			transcript: 'transcript content',
			fetchedAt: 0,
		});
		const out = await pins.buildPreamble();
		expect(out).toContain('File: a.md');
		expect(out).toContain('Web page: Web');
		expect(out).toContain('YouTube transcript: YT');
		// `---` separates the three
		expect(out.split('---')).toHaveLength(3);
	});
});
