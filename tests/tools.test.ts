import { describe, expect, it } from 'vitest';
import {
	bm25TermScore,
	countNewlines,
	countWordOccurrencesNormalized,
	countWords,
	dispatchTool,
	emptyHint,
	findSectionIndex,
	findWordMatchesNormalized,
	getUserIgnoreFilters,
	isUserIgnored,
	LOAD_SKILL_NAME,
	LOAD_SKILL_TOOL_DEF,
	matchesIgnoreFilter,
	matchesPathPrefix,
	normalizeForMatch,
	normalizePathPrefix,
	normalizeTag,
	pathGuard,
	significantTokens,
	stripDuplicateTitleHeading,
	stripEnclosingQuotes,
	toolsToDescriptors,
	TOOLS,
} from '../src/tools';
import type { Tool } from '../src/types';
import { App, TFile, TFolder } from 'obsidian';

// ---------- pathGuard ----------

describe('pathGuard', () => {
	it('blocks .obsidian/', () => {
		expect(pathGuard('.obsidian/config.json', 'Meta')).toMatch(/forbidden/);
		expect(pathGuard('.obsidian', 'Meta')).toMatch(/forbidden/);
	});

	it('blocks absolute and parent-relative paths', () => {
		expect(pathGuard('/etc/passwd', 'Meta')).toMatch(/absolute or parent-relative/);
		expect(pathGuard('../escape.md', 'Meta')).toMatch(/absolute or parent-relative/);
		expect(pathGuard('foo/../bar.md', 'Meta')).toMatch(/absolute or parent-relative/);
	});

	it('blocks the whole `${metaDir}/Smart Aide/` subtree (chats, memory, internals)', () => {
		// Plugin-owned storage all lives under `${metaDir}/Smart Aide/`. The guard
		// blocks the entire subtree as a single rule — save_memory writes through
		// its own code path, not through pathGuard.
		expect(pathGuard('Meta/Smart Aide/chats/x.jsonl', 'Meta')).toMatch(/Smart Aide/);
		expect(pathGuard('Meta/Smart Aide/memory.md', 'Meta')).toMatch(/Smart Aide/);
		expect(pathGuard('Meta/Smart Aide/.internals/foo', 'Meta')).toMatch(/Smart Aide/);
	});

	it('blocks the plugin home even when metaDir has a trailing slash', () => {
		// Regression from v0.1.16: a "sys/" metaDir produced double-slash prefixes
		// that vault-relative paths didn't match. pathGuard normalizes the trailing
		// slash so subtree matches still fire.
		expect(pathGuard('sys/Smart Aide/chats/x.jsonl', 'sys/')).toMatch(/Smart Aide/);
		expect(pathGuard('sys/Smart Aide/memory.md', 'sys/')).toMatch(/Smart Aide/);
	});

	it('blocks the Smart Aide folder itself, not just its contents', () => {
		expect(pathGuard('Meta/Smart Aide', 'Meta')).toMatch(/Smart Aide/);
	});

	it('does not overmatch sibling folders that share a prefix', () => {
		// "MetaNotes" should not be blocked just because metaDir is "Meta".
		expect(pathGuard('MetaNotes/a.md', 'Meta')).toBe('');
		// "Meta/Smart Aide Notes" should not match the "Smart Aide" subtree —
		// the guard requires the trailing-slash boundary.
		expect(pathGuard('Meta/Smart Aide Notes/a.md', 'Meta')).toBe('');
	});

	it('allows ordinary notes and cross-tool standards at the metaDir root', () => {
		// Skills + AGENTS.md are cross-tool standards: they stay at the metaDir
		// root and are NOT inside the Smart Aide subfolder, so they remain
		// readable through general tools.
		expect(pathGuard('Daily/2026-05-23.md', 'Meta')).toBe('');
		expect(pathGuard('Meta/AGENTS.md', 'Meta')).toBe('');
		expect(pathGuard('Meta/skills/foo.md', 'Meta')).toBe('');
	});

	it('enforces .md when requireMarkdown is set', () => {
		expect(pathGuard('Notes/foo.png', 'Meta', { requireMarkdown: true })).toMatch(/.md/);
		expect(pathGuard('Notes/foo.MD', 'Meta', { requireMarkdown: true })).toBe('');
		expect(pathGuard('Notes/foo.md', 'Meta', { requireMarkdown: true })).toBe('');
	});

	it('blocks Smart Aide subtree even when requireMarkdown is set (forbidden wins)', () => {
		// A reader passing requireMarkdown:true on Meta/Smart Aide/chats/x.jsonl
		// should hit the subtree-forbidden error, not the markdown error.
		expect(
			pathGuard('Meta/Smart Aide/chats/x.jsonl', 'Meta', { requireMarkdown: true }),
		).toMatch(/Smart Aide/);
	});
});

// ---------- normalizePathPrefix / matchesPathPrefix ----------

describe('normalizePathPrefix', () => {
	it('strips leading and trailing slashes and trims', () => {
		expect(normalizePathPrefix('  /Daily/  ')).toBe('Daily');
		expect(normalizePathPrefix('Daily/')).toBe('Daily');
		expect(normalizePathPrefix('/Daily')).toBe('Daily');
		expect(normalizePathPrefix('Daily')).toBe('Daily');
	});

	it('returns empty for nullish or whitespace input', () => {
		expect(normalizePathPrefix('')).toBe('');
		expect(normalizePathPrefix('   ')).toBe('');
	});
});

describe('matchesPathPrefix', () => {
	it('matches on segment boundaries, not character prefix', () => {
		// The bug Codex spotted: "Daily" was matching "DailyNotes/..." too.
		expect(matchesPathPrefix('Daily/2026-05-23.md', 'Daily')).toBe(true);
		expect(matchesPathPrefix('DailyNotes/foo.md', 'Daily')).toBe(false);
	});

	it('accepts an exact match', () => {
		expect(matchesPathPrefix('Notes/a.md', 'Notes/a.md')).toBe(true);
	});

	it('treats empty prefix as match-all', () => {
		expect(matchesPathPrefix('Any/Path.md', '')).toBe(true);
	});
});

// ---------- stripDuplicateTitleHeading ----------

describe('stripDuplicateTitleHeading', () => {
	it('removes a leading `# Basename` matching the filename', () => {
		const out = stripDuplicateTitleHeading('Daily/2026-05-23.md', '# 2026-05-23\n\nBody');
		expect(out.startsWith('# 2026-05-23')).toBe(false);
		expect(out).toContain('Body');
	});

	it('preserves frontmatter when stripping the heading', () => {
		const input = '---\ntags: [x]\n---\n# Foo\n\nBody';
		const out = stripDuplicateTitleHeading('Foo.md', input);
		expect(out.startsWith('---')).toBe(true);
		expect(out).toContain('Body');
		expect(out).not.toMatch(/^---[\s\S]*?---\n#\s*Foo/);
	});

	it('leaves a non-matching H1 alone', () => {
		const out = stripDuplicateTitleHeading('Foo.md', '# Bar\n\nBody');
		expect(out).toContain('# Bar');
	});

	it('returns content unchanged when basename is empty', () => {
		expect(stripDuplicateTitleHeading('', '# Anything\nbody')).toBe('# Anything\nbody');
	});

	it('does not strip a partial-match heading', () => {
		const out = stripDuplicateTitleHeading('Foo.md', '# FooBar\n\nBody');
		expect(out).toContain('# FooBar');
	});
});

// ---------- normalizeTag ----------

describe('normalizeTag', () => {
	it('lowercases and prepends #', () => {
		expect(normalizeTag('Book')).toBe('#book');
		expect(normalizeTag('#TASK')).toBe('#task');
	});

	it('returns empty for empty input', () => {
		expect(normalizeTag('')).toBe('');
	});
});

// ---------- emptyHint ----------

describe('emptyHint', () => {
	it('suggests deepSearch when a query was given without it', () => {
		const hint = emptyHint({ query: 'foo', tag: '', pathPrefix: '', sinceDays: undefined, deepSearch: false });
		expect(hint).toMatch(/deepSearch=true/);
	});

	it('omits the deepSearch tip when deepSearch is already on', () => {
		const hint = emptyHint({ query: 'foo', tag: '', pathPrefix: '', sinceDays: undefined, deepSearch: true });
		expect(hint).not.toMatch(/deepSearch=true/);
	});

	it('suggests dropping the pathPrefix when one was used', () => {
		const hint = emptyHint({ query: '', tag: '', pathPrefix: 'Nope', sinceDays: undefined, deepSearch: false });
		expect(hint).toMatch(/pathPrefix/);
	});

	it('returns a plain message when no filters at all were given', () => {
		const hint = emptyHint({ query: '', tag: '', pathPrefix: '', sinceDays: undefined, deepSearch: false });
		expect(hint).toBe('0 matches.');
	});
});

// ---------- findSectionIndex ----------

describe('findSectionIndex', () => {
	const headings = [{ heading: 'Setup' }, { heading: 'Running' }, { heading: 'Teardown' }];

	it('finds an exact case-insensitive match', () => {
		expect(findSectionIndex(headings, 'setup')).toBe(0);
		expect(findSectionIndex(headings, 'TEARDOWN')).toBe(2);
	});

	it('falls back to fuzzy when no exact match', () => {
		expect(findSectionIndex(headings, 'run')).toBe(1);
	});

	it('returns -1 when nothing fuzzy-matches either', () => {
		expect(findSectionIndex(headings, 'zzzz')).toBe(-1);
	});
});

// ---------- dispatchTool through the public surface ----------

describe('dispatchTool — readNote with pathGuard', () => {
	it('rejects non-.md reads', async () => {
		const app = new App();
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'foo.png' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/\.md/);
	});

	it('rejects reads of chats inside the Smart Aide subtree', async () => {
		const app = new App();
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'Meta/Smart Aide/chats/x.jsonl' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});

	it('rejects reads of memory.md through the read tool (no end-run around save_memory)', async () => {
		const app = new App();
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'Meta/Smart Aide/memory.md' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});

	it('rejects reads of plugin internals', async () => {
		const app = new App();
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'Meta/Smart Aide/.internals/foo.md' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});

	it('reports unknown tool name', async () => {
		const out = await dispatchTool(TOOLS, 'no-such-tool', {}, new App(), 'Meta');
		expect(JSON.parse(out).error).toMatch(/unknown tool/);
	});
});

describe('dispatchTool — search_vault basic shape', () => {
	it('errors when no filter is provided', async () => {
		const out = await dispatchTool(TOOLS, 'search_vault', {}, new App(), 'Meta');
		expect(JSON.parse(out).error).toMatch(/at least one/);
	});

	it('returns matches=0 with a hint when query has no hits', async () => {
		const app = new App();
		app.vault.getMarkdownFiles = () => [];
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'nothing' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(0);
		expect(parsed.hint).toMatch(/0 matches/);
	});

	it('matches filename via the fuzzy mock', async () => {
		const file = Object.assign(new TFile(), {
			path: 'Notes/weekly-review.md',
			basename: 'weekly-review',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const app = new App();
		app.vault.getMarkdownFiles = () => [file];
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'weekly' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Notes/weekly-review.md');
	});
});

describe('dispatchTool — list_recent', () => {
	it('sorts newest-first and applies pathPrefix on segment boundary', async () => {
		const a = Object.assign(new TFile(), { path: 'Daily/a.md', basename: 'a', extension: 'md', stat: { mtime: 100, ctime: 0, size: 0 } });
		const b = Object.assign(new TFile(), { path: 'Daily/b.md', basename: 'b', extension: 'md', stat: { mtime: 200, ctime: 0, size: 0 } });
		const c = Object.assign(new TFile(), { path: 'DailyNotes/c.md', basename: 'c', extension: 'md', stat: { mtime: 300, ctime: 0, size: 0 } });
		const app = new App();
		app.vault.getMarkdownFiles = () => [a, b, c];
		const out = await dispatchTool(TOOLS, 'list_recent', { pathPrefix: 'Daily' }, app, 'Meta');
		const parsed = JSON.parse(out);
		// c is excluded because "Daily" only matches the Daily/ folder.
		expect(parsed.count).toBe(2);
		expect(parsed.results[0].path).toBe('Daily/b.md');
		expect(parsed.results[1].path).toBe('Daily/a.md');
	});
});

describe('dispatchTool — get_backlinks', () => {
	it('returns sources that link to the target sorted by count', async () => {
		const app = new App();
		app.metadataCache.resolvedLinks = {
			'src1.md': { 'target.md': 1 },
			'src2.md': { 'target.md': 3, 'other.md': 1 },
			'src3.md': { 'other.md': 1 },
		};
		const out = await dispatchTool(TOOLS, 'get_backlinks', { path: 'target.md' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.count).toBe(2);
		expect(parsed.results[0].path).toBe('src2.md');
		expect(parsed.results[0].count).toBe(3);
	});

	it('errors when no path is given', async () => {
		const out = await dispatchTool(TOOLS, 'get_backlinks', {}, new App(), 'Meta');
		expect(JSON.parse(out).error).toMatch(/required/);
	});
});

void TFolder; // keep import linked for ergonomics

// ---------- write_note / append_to_note / delete_note ----------

function tfile(path: string, content = '', mtime = 1000): TFile {
	const f = Object.assign(new TFile(), {
		path,
		name: path.split('/').pop(),
		basename: (path.split('/').pop() ?? '').replace(/\.md$/, ''),
		extension: 'md',
		stat: { mtime, ctime: 0, size: content.length },
	});
	(f as TFile & { __content: string }).__content = content;
	return f;
}

function appWithFiles(files: TFile[]): App {
	const app = new App();
	app.vault.getFileByPath = (p: string) => files.find((f) => f.path === p) ?? null;
	app.vault.read = async (f: TFile) => (f as TFile & { __content?: string }).__content ?? '';
	app.vault.cachedRead = app.vault.read;
	app.vault.adapter = { exists: async (p: string) => files.some((f) => f.path === p || f.path.startsWith(p + '/')) };
	let created: string | null = null;
	app.vault.create = async (path: string, _content: string) => {
		created = path;
		return tfile(path, _content);
	};
	app.vault.process = async (f: TFile, fn: (c: string) => string) => {
		(f as TFile & { __content?: string }).__content = fn((f as TFile & { __content?: string }).__content ?? '');
	};
	app.vault.append = async (f: TFile, c: string) => {
		(f as TFile & { __content?: string }).__content = ((f as TFile & { __content?: string }).__content ?? '') + c;
	};
	app.fileManager = { trashFile: async () => undefined };
	(app as App & { __created: () => string | null }).__created = () => created;
	return app;
}

describe('write_note', () => {
	it('overwrites an existing file', async () => {
		const file = tfile('Notes/a.md', 'old');
		const app = appWithFiles([file]);
		const out = await dispatchTool(TOOLS, 'write_note', { path: 'Notes/a.md', content: 'new' }, app, 'Meta');
		expect(JSON.parse(out).status).toBe('overwritten');
		expect((file as TFile & { __content: string }).__content).toBe('new');
	});

	it('creates a new file when none exists', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'write_note', { path: 'Notes/new.md', content: '# body' }, app, 'Meta');
		expect(JSON.parse(out).status).toBe('created');
	});

	it('strips a duplicate `# Basename` heading on write', async () => {
		const file = tfile('Foo.md', 'old');
		const app = appWithFiles([file]);
		await dispatchTool(TOOLS, 'write_note', { path: 'Foo.md', content: '# Foo\n\nbody' }, app, 'Meta');
		expect((file as TFile & { __content: string }).__content).toBe('body');
	});

	it('refuses to write into the Smart Aide subtree', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'write_note', { path: 'Meta/Smart Aide/chats/a.jsonl', content: 'x' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});

	it('refuses to write memory.md via write_note (forces save_memory tool)', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'write_note', { path: 'Meta/Smart Aide/memory.md', content: 'forged' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});

	it('refuses absolute and parent-relative paths', async () => {
		const app = appWithFiles([]);
		const o1 = await dispatchTool(TOOLS, 'write_note', { path: '/etc/foo.md', content: 'x' }, app, 'Meta');
		expect(JSON.parse(o1).error).toMatch(/absolute or parent/);
		const o2 = await dispatchTool(TOOLS, 'write_note', { path: '../escape.md', content: 'x' }, app, 'Meta');
		expect(JSON.parse(o2).error).toMatch(/absolute or parent/);
	});

	it('rejects when path is missing (pathGuard catches the empty/normalized path)', async () => {
		const out = await dispatchTool(TOOLS, 'write_note', { content: 'x' }, new App(), 'Meta');
		// strArg('') -> '', normalizePath('') -> '/', then pathGuard fires on absolute.
		expect(JSON.parse(out).error).toBeTruthy();
	});
});

describe('append_to_note', () => {
	it('appends to an existing file', async () => {
		const file = tfile('Notes/a.md', 'hello');
		const app = appWithFiles([file]);
		const out = await dispatchTool(TOOLS, 'append_to_note', { path: 'Notes/a.md', content: '\nmore' }, app, 'Meta');
		expect(JSON.parse(out).status).toBe('appended');
		expect((file as TFile & { __content: string }).__content).toBe('hello\nmore');
	});

	it('errors when the file does not exist', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'append_to_note', { path: 'Notes/missing.md', content: 'x' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/not found/);
	});

	it('honors the path guard', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'append_to_note', { path: 'Meta/Smart Aide/.internals/x', content: 'x' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});
});

describe('delete_note', () => {
	it('trashes an existing file', async () => {
		const file = tfile('Notes/a.md', 'x');
		const app = appWithFiles([file]);
		let trashed: TFile | null = null;
		app.fileManager.trashFile = async (f: TFile) => { trashed = f; };
		const out = await dispatchTool(TOOLS, 'delete_note', { path: 'Notes/a.md' }, app, 'Meta');
		expect(JSON.parse(out).status).toBe('deleted');
		expect(trashed).toBe(file);
	});

	it('errors when the file does not exist', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'delete_note', { path: 'Notes/nope.md' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/not found/);
	});

	it('refuses to delete inside the Smart Aide subtree', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'delete_note', { path: 'Meta/Smart Aide/chats/a.jsonl' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/Smart Aide/);
	});
});

// ---------- read_note advanced modes ----------

describe('read_note section + range modes', () => {
	it('reads a specific line range', async () => {
		const content = ['a', 'b', 'c', 'd', 'e'].join('\n');
		const file = tfile('a.md', content);
		const app = appWithFiles([file]);
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'a.md', startLine: 2, endLine: 4 }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.startLine).toBe(2);
		expect(parsed.endLine).toBe(4);
		expect(parsed.content).toBe('b\nc\nd');
	});

	it('reads a section by heading name', async () => {
		const content = ['# Top', 'intro', '## Setup', 'install', 'step 2', '## Next', 'tail'].join('\n');
		const file = tfile('a.md', content);
		const app = appWithFiles([file]);
		app.metadataCache.getFileCache = () => ({
			headings: [
				{ heading: 'Top', level: 1, position: { start: { line: 0 } } },
				{ heading: 'Setup', level: 2, position: { start: { line: 2 } } },
				{ heading: 'Next', level: 2, position: { start: { line: 5 } } },
			],
		});
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'a.md', section: 'Setup' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.content).toContain('install');
		expect(parsed.content).toContain('step 2');
		expect(parsed.content).not.toContain('Next');
	});

	it('errors when section is requested on a file with no headings', async () => {
		const file = tfile('a.md', 'just text');
		const app = appWithFiles([file]);
		app.metadataCache.getFileCache = () => ({ headings: [] });
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'a.md', section: 'Setup' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/no headings/);
	});

	it('lists availableHeadings when section does not match', async () => {
		const file = tfile('a.md', '# Other\nbody');
		const app = appWithFiles([file]);
		app.metadataCache.getFileCache = () => ({
			headings: [{ heading: 'Other', level: 1, position: { start: { line: 0 } } }],
		});
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'a.md', section: 'zzz-nomatch' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.error).toMatch(/no heading matches/);
		expect(parsed.availableHeadings).toEqual(['Other']);
	});

	it('reports not-found for a missing file', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'missing.md' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/not found/);
	});

	it('returns the full file for small notes', async () => {
		const file = tfile('a.md', 'tiny');
		const app = appWithFiles([file]);
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'a.md' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.content).toBe('tiny');
		expect(parsed.truncated).toBeUndefined();
	});

	it('auto-truncates files over the soft limit', async () => {
		// Construct a 70KB file (above the 60KB threshold).
		const big = 'x'.repeat(70_000);
		const file = tfile('big.md', big);
		const app = appWithFiles([file]);
		app.metadataCache.getFileCache = () => ({ headings: [] });
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'big.md' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.truncated).toBe(true);
		expect(parsed.bytes).toBe(70_000);
		expect(parsed.hint).toMatch(/read_note/);
	});
});

describe('search_vault advanced paths', () => {
	it('matches headings via MetadataCache', async () => {
		const f = tfile('Notes/long.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => ({
			headings: [
				{ heading: 'Top', level: 1, position: { start: { line: 0 } } },
				{ heading: 'weekly review template', level: 2, position: { start: { line: 5 } } },
			],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'weekly' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		const hits = parsed.results[0].hits;
		expect(hits.find((h: { in: string }) => h.in === 'heading')).toBeTruthy();
	});

	it('filters by tag (frontmatter)', async () => {
		const a = tfile('a.md');
		const b = tfile('b.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [a, b];
		app.metadataCache.getFileCache = (f: TFile) => {
			if (f === a) return { frontmatter: { tags: ['book'] }, tags: [] };
			return { frontmatter: { tags: ['movie'] }, tags: [] };
		};
		const out = await dispatchTool(TOOLS, 'search_vault', { tag: 'book' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('a.md');
	});

	it('content scan adds hits to already-bucketed files (RRF multi-surface evidence)', async () => {
		// Pre-fix bug: bucketed files were skipped during the content scan, so a
		// file matching on filename AND body only got the filename hit — losing
		// the strongest RRF signal. Now content hits add to bucketed files too,
		// and the multi-surface file ranks above the body-only file.
		const filenameAndBody = tfile('foo.md', 'this body also has foo');
		const bodyOnly = tfile('other.md', 'a long body that mentions foo deep inside');
		(filenameAndBody as TFile & { __content: string }).__content = 'this body also has foo';
		(bodyOnly as TFile & { __content: string }).__content = 'a long body that mentions foo deep inside';

		const app = new App();
		app.vault.getMarkdownFiles = () => [filenameAndBody, bodyOnly];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'foo', deepSearch: true }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(2);
		const filenameAndBodyResult = parsed.results.find((r: { path: string }) => r.path === 'foo.md');
		const bodyOnlyResult = parsed.results.find((r: { path: string }) => r.path === 'other.md');
		// Multi-surface match: filename + content hits both recorded.
		const ins = new Set<string>(filenameAndBodyResult.hits.map((h: { in: string }) => h.in));
		expect(ins.has('filename')).toBe(true);
		expect(ins.has('content')).toBe(true);
		expect(filenameAndBodyResult.matchedSurfaces).toContain('filename');
		expect(filenameAndBodyResult.matchedSurfaces).toContain('content');
		// Body-only file still gets its content hit.
		expect(bodyOnlyResult.hits.some((h: { in: string }) => h.in === 'content')).toBe(true);
		// RRF: multi-surface file ranks above body-only file.
		expect(parsed.results[0].path).toBe('foo.md');
	});

	it('applies sinceDays filter', async () => {
		const recent = tfile('recent.md', '', Date.now() - 1_000); // 1 second ago
		const old = tfile('old.md', '', Date.now() - 1000 * 60 * 60 * 24 * 365); // a year ago
		const app = new App();
		app.vault.getMarkdownFiles = () => [recent, old];
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'recent', sinceDays: 1 }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('recent.md');
	});

	it('returns a "showing top" hint when results exceed maxResults', async () => {
		const files = Array.from({ length: 15 }, (_, i) => tfile(`note-${i}.md`));
		const app = new App();
		app.vault.getMarkdownFiles = () => files;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'note', maxResults: 5 }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(15);
		expect(parsed.returned).toBe(5);
		expect(parsed.hint).toMatch(/Showing top/);
	});

	it('filters by pathPrefix combined with query (segment-boundary match)', async () => {
		const inFolder = tfile('Daily/note.md');
		const outOfFolder = tfile('DailyNotes/note.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [inFolder, outOfFolder];
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'note', pathPrefix: 'Daily' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Daily/note.md');
	});

	it('records a tag hit when query fuzzy-matches a frontmatter tag', async () => {
		const f = tfile('Notes/x.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => ({
			headings: [],
			frontmatter: { tags: ['weekly-review'] },
			tags: [],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'weekly' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].hits.some((h: { in: string }) => h.in === 'tag')).toBe(true);
	});

	it('sorts hits within a file by tier (filename > heading)', async () => {
		// A note whose filename + a heading both fuzzy-match "weekly".
		const f = tfile('Notes/weekly.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => ({
			headings: [{ heading: 'weekly summary', level: 2, position: { start: { line: 5 } } }],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'weekly' }, app, 'Meta');
		const parsed = JSON.parse(out);
		const hits = parsed.results[0].hits;
		expect(hits.length).toBeGreaterThanOrEqual(2);
		// filename tier should come before heading tier in the sorted display.
		expect(hits[0].in).toBe('filename');
	});

	it('emits a heading hit endLine that points at the next same-level heading', async () => {
		// Triggers sectionEndLine's "return next heading" branch.
		const f = tfile('Notes/long.md');
		(f as TFile & { stat: { size: number } }).stat.size = 1000;
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => ({
			headings: [
				{ heading: 'weekly review', level: 2, position: { start: { line: 5 } } },
				{ heading: 'next section', level: 2, position: { start: { line: 12 } } },
			],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'weekly review' }, app, 'Meta');
		const parsed = JSON.parse(out);
		const headingHit = parsed.results[0].hits.find((h: { in: string }) => h.in === 'heading');
		expect(headingHit.endLine).toBe(12);
	});
});

describe('stripEnclosingQuotes', () => {
	it('strips matched double quotes', () => {
		expect(stripEnclosingQuotes('"thou art"')).toBe('thou art');
	});
	it('strips matched single quotes', () => {
		expect(stripEnclosingQuotes("'thou art'")).toBe('thou art');
	});
	it('leaves mismatched or interior quotes alone', () => {
		expect(stripEnclosingQuotes('"unbalanced')).toBe('"unbalanced');
		expect(stripEnclosingQuotes('he said "hi"')).toBe('he said "hi"');
	});
	it('leaves bare strings alone', () => {
		expect(stripEnclosingQuotes('thou art')).toBe('thou art');
	});
});

describe('search_vault — regression: noisy queries and quote echo', () => {
	const filesFor = (paths: string[]) =>
		paths.map((p) => {
			const f = new TFile();
			f.path = p;
			f.basename = p.split('/').pop()!.replace(/\.md$/, '');
			f.extension = 'md';
			f.stat = { mtime: 0, ctime: 0, size: 0 };
			return f;
		});

	// Models often echo the user's quoting ("the words 'thou art'" → query='"thou art"').
	// Without quote stripping, the substring scan looks for literal `"thou art"` and misses
	// the target file containing `"Thou art..."` (ellipsis breaks the closing-quote match).
	it('quoted phrase query still finds files with the unquoted phrase in body', async () => {
		const target = filesFor(['Areas/Improv/Mid Show.md'])[0];
		(target as TFile & { __content: string }).__content =
			'Some intro\n\n- "Thou art..." - it has become a god';
		const app = new App();
		app.vault.getMarkdownFiles = () => [target];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: '"thou art"', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Areas/Improv/Mid Show.md');
		expect(parsed.results[0].hits[0].in).toBe('content');
	});

	// prepareFuzzySearch matched "The Four Agreements" against "thou art" because
	// the characters t-h-o-u-a-r-t can be found scattered in order. prepareSimpleSearch
	// is word-tokenized: every space-separated token must appear as a substring.
	it('multi-word query does not match unrelated filenames via character scatter', async () => {
		const noise = filesFor([
			'Resources/The Four Agreements.md',
			'Projects/Project Shopify.md',
		]);
		const target = filesFor(['Areas/Improv/Mid Show.md'])[0];
		(target as TFile & { __content: string }).__content = '"Thou art..." line';

		const app = new App();
		app.vault.getMarkdownFiles = () => [...noise, target];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content ?? '';
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'thou art', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		// Only the target should match — no accidental filename hits on noise files.
		const paths = parsed.results.map((r: { path: string }) => r.path);
		expect(paths).toEqual(['Areas/Improv/Mid Show.md']);
	});

	it('deepSearch raises the default maxResults so content hits aren\'t crowded out', async () => {
		// 15 files whose basename contains the literal token "note", plus one content-only
		// match. With DEFAULT_MAX_RESULTS=10 the content hit would be cut off; deepSearch
		// bumps to 25 so it survives.
		const namedNotes = filesFor(Array.from({ length: 15 }, (_, i) => `n-${i}-note.md`));
		const contentOnly = filesFor(['other/special.md'])[0];
		(contentOnly as TFile & { __content: string }).__content = 'mentions note in body';

		const app = new App();
		app.vault.getMarkdownFiles = () => [...namedNotes, contentOnly];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content ?? '';
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'note', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(16);
		expect(parsed.returned).toBe(16);
		const paths = parsed.results.map((r: { path: string }) => r.path);
		expect(paths).toContain('other/special.md');
	});
});

describe('word-boundary content matching (regression: substring contamination)', () => {
	it('deepSearch content scan does not return files where the token only appears as substring', async () => {
		const fileWith = (path: string, content: string): TFile => {
			const f = new TFile();
			f.path = path;
			f.basename = path.split('/').pop()!.replace(/\.md$/, '');
			f.extension = 'md';
			f.stat = { mtime: 0, ctime: 0, size: 0 };
			(f as TFile & { __content: string }).__content = content;
			return f;
		};

		// The v0.2.10 bug: these meditation/journal-style notes flooded results
		// for the query "thou art" because "thou" was a substring of "thoughts"
		// and "art" was a substring of "started", "without", etc.
		const noise = [
			fileWith('Meditation.md', 'thoughts arise without grasping, thoughts return to breath'),
			fileWith('Journal.md', 'without practice the start of the day is rough'),
			fileWith('Article.md', 'this article describes the artistry of starting fresh'),
		];
		const target = fileWith('Improv.md', '"Thou art..." it has become a god');

		const app = new App();
		app.vault.getMarkdownFiles = () => [...noise, target];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'thou art', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Improv.md');
	});

	it('phrase boost: files with adjacent "thou art" rank above files with both words scattered', async () => {
		const fileWith = (path: string, content: string): TFile => {
			const f = new TFile();
			f.path = path;
			f.basename = path.split('/').pop()!.replace(/\.md$/, '');
			f.extension = 'md';
			f.stat = { mtime: 0, ctime: 0, size: 0 };
			(f as TFile & { __content: string }).__content = content;
			return f;
		};

		const phraseFile = fileWith('phrase.md', '"Thou art..." it has become a god');
		// Many "thou" and "art" occurrences as words, but never adjacent.
		const scatteredFile = fileWith(
			'scattered.md',
			'thou shalt not. and the art of war. thou again. art exhibition. thou. art.',
		);

		const app = new App();
		app.vault.getMarkdownFiles = () => [scatteredFile, phraseFile];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'thou art', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.results[0].path).toBe('phrase.md');
	});
});

describe('BM25 + RRF helpers', () => {
	it('bm25TermScore returns 0 for zero term frequency', () => {
		expect(bm25TermScore(0, 100, 100, 1)).toBe(0);
	});

	it('bm25TermScore rewards more matches with diminishing returns', () => {
		const oneHit = bm25TermScore(1, 100, 100, 1);
		const fiveHits = bm25TermScore(5, 100, 100, 1);
		const fiftyHits = bm25TermScore(50, 100, 100, 1);
		expect(fiveHits).toBeGreaterThan(oneHit);
		expect(fiftyHits).toBeGreaterThan(fiveHits);
		// Diminishing returns: 1→5 should be a bigger jump than 5→50.
		expect(fiveHits - oneHit).toBeGreaterThan(fiftyHits - fiveHits);
	});

	it('bm25TermScore penalizes longer documents at the same term frequency', () => {
		const short = bm25TermScore(3, 50, 200, 1);
		const long = bm25TermScore(3, 800, 200, 1);
		expect(short).toBeGreaterThan(long);
	});
});

describe('search_vault — BM25 ranking on content hits', () => {
	const fileWith = (path: string, content: string): TFile => {
		const f = new TFile();
		f.path = path;
		f.basename = path.split('/').pop()!.replace(/\.md$/, '');
		f.extension = 'md';
		f.stat = { mtime: 0, ctime: 0, size: 0 };
		(f as TFile & { __content: string }).__content = content;
		return f;
	};

	it('ranks files with more on-topic mentions above files with one incidental mention', async () => {
		// Two files both contain "kafka" but one is densely about it.
		const dense = fileWith(
			'dense.md',
			'kafka consumer kafka producer kafka topic kafka partition kafka offset',
		);
		const sparse = fileWith(
			'sparse.md',
			'this is a very long note about many things including occasionally kafka and then a long tail of unrelated words that pads out the document length significantly to dilute the signal',
		);
		const app = new App();
		app.vault.getMarkdownFiles = () => [sparse, dense];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'kafka', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.results[0].path).toBe('dense.md');
	});
});

describe('search_vault — RRF cross-surface ranking', () => {
	const file = (path: string): TFile => {
		const f = new TFile();
		f.path = path;
		f.basename = path.split('/').pop()!.replace(/\.md$/, '');
		f.extension = 'md';
		f.stat = { mtime: 0, ctime: 0, size: 0 };
		return f;
	};

	it('a file matched across multiple surfaces beats a file matched on filename alone', async () => {
		// Both files have the word "improv" in their basename. But the multi-surface
		// file also has it in a heading and a tag. RRF should rank it first.
		const filenameOnly = file('Improv Solo.md');
		const multiSurface = file('Improv Games.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [filenameOnly, multiSurface];
		app.metadataCache.getFileCache = (f: TFile) => {
			if (f === multiSurface) {
				return {
					headings: [{ heading: 'Improv warmup', level: 2, position: { start: { line: 0 } } }],
					frontmatter: { tags: ['improv'] },
					tags: [],
				};
			}
			return null;
		};

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'improv' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(2);
		expect(parsed.results[0].path).toBe('Improv Games.md');
		expect(parsed.results[1].path).toBe('Improv Solo.md');
	});
});

describe('search_vault — fuzzy fallback', () => {
	const filesFor = (paths: string[]) =>
		paths.map((p) => {
			const f = new TFile();
			f.path = p;
			f.basename = p.split('/').pop()!.replace(/\.md$/, '');
			f.extension = 'md';
			f.stat = { mtime: 0, ctime: 0, size: 0 };
			return f;
		});

	it('catches typos (letter omission)', async () => {
		const f = filesFor(['Improv Openings.md'])[0];
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => null;

		// Simple search for "imrov" (missing p) fails — "imrov" is not a substring of "Improv Openings".
		// Fuzzy fallback finds it via i,m,r,o,v in order.
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'imrov' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.fuzzyFallback).toBe(true);
		expect(parsed.results[0].path).toBe('Improv Openings.md');
	});

	it('does not fire when simple search succeeds', async () => {
		const f = filesFor(['Improv Openings.md'])[0];
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'improv' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.fuzzyFallback).toBeUndefined();
	});

	it('catches first-letter abbreviations (quick-switcher style)', async () => {
		const f = filesFor(['Improv Openings Mid Show.md'])[0];
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'ioms' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.fuzzyFallback).toBe(true);
	});

	it('does not fire on a successful deepSearch content hit', async () => {
		const f = filesFor(['note.md'])[0];
		(f as TFile & { __content: string }).__content = 'the body contains thou art here';
		const app = new App();
		app.vault.getMarkdownFiles = () => [f];
		app.vault.cachedRead = async (file: TFile) => (file as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'thou art', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.fuzzyFallback).toBeUndefined();
	});
});

describe('read_note section ends at end-of-file', () => {
	it('returns the section through totalLines when no following same-or-higher heading', async () => {
		// "Setup" is the last heading; sectionEndLineByTotal should return totalLines.
		const content = ['# Top', 'intro', '## Setup', 'install', 'step 2', 'step 3'].join('\n');
		const file = tfile('a.md', content);
		const app = appWithFiles([file]);
		app.metadataCache.getFileCache = () => ({
			headings: [
				{ heading: 'Top', level: 1, position: { start: { line: 0 } } },
				{ heading: 'Setup', level: 2, position: { start: { line: 2 } } },
			],
		});
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'a.md', section: 'Setup' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.content).toContain('install');
		expect(parsed.content).toContain('step 3');
	});
});

describe('write/append/delete preview()', () => {
	it('write_note preview reports Overwrite for an existing file', async () => {
		const file = tfile('Notes/a.md', 'old');
		const app = appWithFiles([file]);
		const writeTool = TOOLS.find((t: Tool) => t.name === 'write_note')!;
		const preview = await writeTool.preview!({ path: 'Notes/a.md', content: '# a\nnew' }, { app, metaDir: 'Meta' });
		expect(preview.summary).toMatch(/Overwrite/);
		expect(preview.diff?.kind).toBe('overwrite');
		// stripDuplicateTitleHeading kicks in for the preview newContent.
		expect(preview.diff?.newContent).not.toMatch(/^# a/);
	});

	it('write_note preview reports Create for a missing file', async () => {
		const app = appWithFiles([]);
		const writeTool = TOOLS.find((t: Tool) => t.name === 'write_note')!;
		const preview = await writeTool.preview!({ path: 'Notes/new.md', content: 'body' }, { app, metaDir: 'Meta' });
		expect(preview.summary).toMatch(/Create/);
		expect(preview.diff?.oldContent).toBe('');
	});

	it('append_to_note preview reports "Append to" for an existing file', async () => {
		const file = tfile('Notes/a.md', 'old');
		const app = appWithFiles([file]);
		const appendTool = TOOLS.find((t: Tool) => t.name === 'append_to_note')!;
		const preview = await appendTool.preview!({ path: 'Notes/a.md', content: 'tail' }, { app, metaDir: 'Meta' });
		expect(preview.summary).toMatch(/Append to/);
		expect(preview.diff?.kind).toBe('append');
		expect(preview.diff?.newContent).toBe('tail');
	});

	it('append_to_note preview flags a missing file in the summary', async () => {
		const app = appWithFiles([]);
		const appendTool = TOOLS.find((t: Tool) => t.name === 'append_to_note')!;
		const preview = await appendTool.preview!({ path: 'Notes/missing.md', content: 'x' }, { app, metaDir: 'Meta' });
		expect(preview.summary).toMatch(/Cannot append/);
	});

	it('delete_note preview reports "Delete" with the old content', async () => {
		const file = tfile('Notes/a.md', 'doomed');
		const app = appWithFiles([file]);
		const deleteTool = TOOLS.find((t: Tool) => t.name === 'delete_note')!;
		const preview = await deleteTool.preview!({ path: 'Notes/a.md' }, { app, metaDir: 'Meta' });
		expect(preview.summary).toMatch(/Delete/);
		expect(preview.diff?.kind).toBe('delete');
		expect(preview.diff?.oldContent).toBe('doomed');
	});

	it('delete_note preview returns empty oldContent when the file is missing', async () => {
		const app = appWithFiles([]);
		const deleteTool = TOOLS.find((t: Tool) => t.name === 'delete_note')!;
		const preview = await deleteTool.preview!({ path: 'Notes/missing.md' }, { app, metaDir: 'Meta' });
		expect(preview.diff?.oldContent).toBe('');
	});

	it('write_note preview blocks forbidden paths without reading file content', async () => {
		const file = tfile('Meta/Smart Aide/chats/secret.md', 'should not be exposed');
		const app = appWithFiles([file]);
		const writeTool = TOOLS.find((t: Tool) => t.name === 'write_note')!;
		const preview = await writeTool.preview!(
			{ path: 'Meta/Smart Aide/chats/secret.md', content: 'x' },
			{ app, metaDir: 'Meta' },
		);
		expect(preview.summary).toMatch(/^Blocked write/);
		expect(preview.summary).toMatch(/Smart Aide/);
		expect(preview.diff).toBeUndefined();
	});

	it('append_to_note preview blocks forbidden paths', async () => {
		const file = tfile('.obsidian/workspace.md', 'config');
		const app = appWithFiles([file]);
		const appendTool = TOOLS.find((t: Tool) => t.name === 'append_to_note')!;
		const preview = await appendTool.preview!(
			{ path: '.obsidian/workspace.md', content: 'tail' },
			{ app, metaDir: 'Meta' },
		);
		expect(preview.summary).toMatch(/^Blocked append/);
		expect(preview.diff).toBeUndefined();
	});

	it('delete_note preview blocks forbidden paths without reading file content', async () => {
		const file = tfile('Meta/Smart Aide/chats/secret.md', 'should not be exposed');
		const app = appWithFiles([file]);
		const deleteTool = TOOLS.find((t: Tool) => t.name === 'delete_note')!;
		const preview = await deleteTool.preview!(
			{ path: 'Meta/Smart Aide/chats/secret.md' },
			{ app, metaDir: 'Meta' },
		);
		expect(preview.summary).toMatch(/^Blocked delete/);
		expect(preview.diff).toBeUndefined();
	});

	it('write_note preview blocks non-markdown extensions', async () => {
		const app = appWithFiles([]);
		const writeTool = TOOLS.find((t: Tool) => t.name === 'write_note')!;
		const preview = await writeTool.preview!(
			{ path: 'Notes/script.js', content: 'x' },
			{ app, metaDir: 'Meta' },
		);
		expect(preview.summary).toMatch(/^Blocked write/);
		expect(preview.diff).toBeUndefined();
	});
});

describe('load_skill is not in TOOLS', () => {
	it('is routed past dispatchTool — the view layer handles it directly', async () => {
		expect(TOOLS.find((t) => t.name === LOAD_SKILL_NAME)).toBeUndefined();
		const out = await dispatchTool(TOOLS, LOAD_SKILL_NAME, { name: 'whatever' }, new App(), 'Meta');
		expect(JSON.parse(out).error).toMatch(/unknown tool/);
	});
});

describe('toolsToDescriptors', () => {
	it('produces a neutral {name, description, parameters} for each tool', () => {
		const out = toolsToDescriptors(TOOLS);
		expect(out.length).toBe(TOOLS.length);
		for (const t of out) {
			expect(typeof t.name).toBe('string');
			expect(typeof t.description).toBe('string');
			expect(t.parameters).toBeTruthy();
		}
		const names = out.map((t) => t.name);
		expect(names).toContain('search_vault');
		expect(names).toContain('read_note');
	});

	it('LOAD_SKILL_TOOL_DEF is a neutral descriptor (not OpenAI-wrapped)', () => {
		expect(LOAD_SKILL_TOOL_DEF.name).toBe(LOAD_SKILL_NAME);
		expect(typeof LOAD_SKILL_TOOL_DEF.description).toBe('string');
		expect(LOAD_SKILL_TOOL_DEF.parameters).toMatchObject({
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
		});
	});
});

describe('dispatchTool — execute throws', () => {
	it('catches the error and returns a JSON error payload', async () => {
		const failing: Tool = {
			name: 'boom',
			description: 'always throws',
			parameters: { type: 'object', properties: {} },
			risk: 'read',
			async execute() { throw new Error('kaboom'); },
		};
		const out = await dispatchTool([failing], 'boom', {}, new App(), 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.error).toMatch(/tool boom failed: kaboom/);
	});

	it('coerces non-Error throws into the error string', async () => {
		const failing: Tool = {
			name: 'boom',
			description: 'always throws',
			parameters: { type: 'object', properties: {} },
			risk: 'read',
			async execute() { throw 'rope'; },
		};
		const out = await dispatchTool([failing], 'boom', {}, new App(), 'Meta');
		expect(JSON.parse(out).error).toMatch(/rope/);
	});
});

// ---------- New surfaces, normalization, auto-body, heading context ----------

function searchFile(path: string, content = '', mtime = 0): TFile {
	const f = new TFile();
	f.path = path;
	f.basename = (path.split('/').pop() ?? '').replace(/\.md$/, '');
	f.extension = 'md';
	f.stat = { mtime, ctime: 0, size: content.length };
	(f as TFile & { __content: string }).__content = content;
	return f;
}

describe('normalizeForMatch / significantTokens', () => {
	it('lowercases and collapses hyphen/underscore/slash to space', () => {
		expect(normalizeForMatch('Deep-Work')).toBe('deep work');
		expect(normalizeForMatch('deep_work')).toBe('deep work');
		expect(normalizeForMatch('deep/work')).toBe('deep work');
	});

	it('strips diacritics via NFKD decomposition', () => {
		expect(normalizeForMatch('résumé')).toBe('resume');
		expect(normalizeForMatch('café au lait')).toBe('cafe au lait');
	});

	it('drops stopwords and length-1 tokens', () => {
		expect(significantTokens('where did I write about support characters'))
			.toEqual(['support', 'characters']);
		expect(significantTokens('the quick brown fox')).toEqual(['quick', 'brown', 'fox']);
	});

	it('returns empty when the whole query is filler/short — caller falls back to phrase', () => {
		// "A to C": "a" length-1, "to" stopword, "c" length-1 → all dropped.
		// Caller (runContentScan) detects empty significantTokens and requires the
		// phrase to be present instead of an AND-gate over tokens.
		expect(significantTokens('A to C')).toEqual([]);
		expect(significantTokens('the of')).toEqual([]);
	});

	it('countWordOccurrencesNormalized matches across hyphen/underscore', () => {
		const normalized = normalizeForMatch('I work on deep-work and deep_work daily');
		expect(countWordOccurrencesNormalized(normalized, 'deep work')).toBe(2);
	});

	it('findWordMatchesNormalized returns positions from the original text', () => {
		const original = 'line one\nthis is deep-work mention\nline three';
		const normalized = normalizeForMatch(original);
		const matches = findWordMatchesNormalized(original, normalized, 'deep work', 5);
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(2);
		expect(matches[0].snippet).toContain('deep-work');
	});
});

describe('search_vault — alias surface', () => {
	it('matches an alias from frontmatter and tags the hit with in: "alias"', async () => {
		// vault-realistic case: zkmd's Camelcase.md has aliases ["PascalCase", "Camel Case"].
		const file = searchFile('Resources/Camelcase.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [file];
		app.metadataCache.getFileCache = () => ({
			frontmatter: { aliases: ['PascalCase', 'Camel Case'] },
			headings: [],
			tags: [],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'PascalCase' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		const r = parsed.results[0];
		expect(r.path).toBe('Resources/Camelcase.md');
		const aliasHit = r.hits.find((h: { in: string }) => h.in === 'alias');
		expect(aliasHit).toBeTruthy();
		expect(aliasHit.text).toBe('PascalCase');
		expect(r.matchedSurfaces).toContain('alias');
	});

	it('alias hit ranks above body-content hit when both surfaces match', async () => {
		// A note where the alias matches AND the body contains the query.
		// RRF + tier priority should put the alias-matched file on top because
		// alias is a stronger metadata signal than body content.
		const aliased = searchFile('Resources/Camelcase.md', 'See also: PascalCase elsewhere.');
		const bodyOnly = searchFile('Resources/Notes.md', 'mentions PascalCase once');
		const app = new App();
		app.vault.getMarkdownFiles = () => [aliased, bodyOnly];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = (f: TFile) => {
			if (f === aliased) return { frontmatter: { aliases: ['PascalCase'] }, headings: [], tags: [] };
			return null;
		};
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'PascalCase', deepSearch: true }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.results[0].path).toBe('Resources/Camelcase.md');
	});
});

describe('search_vault — linkDisplayText surface', () => {
	it('matches a wikilink display text and exposes targetPath', async () => {
		// Daily/2024-01-21.md contains `[[The Dhammapada - Easwaran|Dharmapada]]`.
		// A query for "Dharmapada" should find that daily note WITHOUT scanning bodies.
		const dailyNote = searchFile('Daily/2024-01-21.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [dailyNote];
		app.metadataCache.getFileCache = (f: TFile) => {
			if (f === dailyNote) {
				return {
					headings: [],
					tags: [],
					links: [
						{
							link: 'The Dhammapada - Easwaran',
							original: '[[The Dhammapada - Easwaran|Dharmapada]]',
							displayText: 'Dharmapada',
						},
					],
				};
			}
			return null;
		};
		const target = searchFile('Resources/The Dhammapada - Easwaran.md');
		app.metadataCache.getFirstLinkpathDest = (link: string) =>
			link === 'The Dhammapada - Easwaran' ? target : null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'Dharmapada' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		const r = parsed.results[0];
		expect(r.path).toBe('Daily/2024-01-21.md');
		const linkHit = r.hits.find((h: { in: string }) => h.in === 'linkDisplayText');
		expect(linkHit).toBeTruthy();
		expect(linkHit.text).toBe('Dharmapada');
		expect(linkHit.targetPath).toBe('Resources/The Dhammapada - Easwaran.md');
		expect(r.matchedSurfaces).toContain('linkDisplayText');
	});

	it('falls back to the raw link target when there is no displayText', async () => {
		const file = searchFile('Daily/x.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [file];
		app.metadataCache.getFileCache = () => ({
			headings: [],
			tags: [],
			links: [{ link: 'Improv Openings', original: '[[Improv Openings]]' }],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'Improv Openings' }, app, 'Meta');
		const parsed = JSON.parse(out);
		const linkHit = parsed.results[0].hits.find((h: { in: string }) => h.in === 'linkDisplayText');
		expect(linkHit.text).toBe('Improv Openings');
	});
});

describe('search_vault — matchedSurfaces', () => {
	it('lists every surface that fired for a file (filename + alias + tag)', async () => {
		const file = searchFile('Resources/Camelcase.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [file];
		app.metadataCache.getFileCache = () => ({
			frontmatter: { aliases: ['Camelcase'], tags: ['camelcase'] },
			headings: [],
			tags: [],
		});
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'camelcase' }, app, 'Meta');
		const parsed = JSON.parse(out);
		const surfaces = parsed.results[0].matchedSurfaces;
		expect(surfaces).toContain('filename');
		expect(surfaces).toContain('alias');
		expect(surfaces).toContain('tag');
	});
});

describe('search_vault — auto-body trigger', () => {
	it('scans bodies even with deepSearch=false when metadata returns 0 hits, sets autoBody=true', async () => {
		const bodyOnly = searchFile('Notes/error-budgets.md', 'thinking about error budgets and trust today');
		const app = new App();
		app.vault.getMarkdownFiles = () => [bodyOnly];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'error budgets and trust' },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.autoBody).toBe(true);
		expect(parsed.deepSearch).toBe(false);
		expect(parsed.results[0].hits.some((h: { in: string }) => h.in === 'content')).toBe(true);
	});

	it('triggers on a quoted query even when metadata is rich', async () => {
		// Many files exist with matching filenames; the quoted query still
		// triggers body scan because the user explicitly quoted a phrase.
		const filenameMatches = Array.from({ length: 8 }, (_, i) => searchFile(`Notes/eventual-${i}.md`));
		const bodyMatch = searchFile('Other/special.md', 'remember eventual consistency in the writeup');
		const app = new App();
		app.vault.getMarkdownFiles = () => [...filenameMatches, bodyMatch];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content ?? '';
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: '"eventual consistency"' },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.autoBody).toBe(true);
		const paths = parsed.results.map((r: { path: string }) => r.path);
		expect(paths).toContain('Other/special.md');
	});

	it('does NOT set autoBody when deepSearch=true was the trigger', async () => {
		const file = searchFile('a.md', 'foo here');
		const app = new App();
		app.vault.getMarkdownFiles = () => [file];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'foo', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.autoBody).toBeUndefined();
		expect(parsed.deepSearch).toBe(true);
	});

	it('does NOT trigger when metadata already has 6+ matches and query is unquoted', async () => {
		const files = Array.from({ length: 8 }, (_, i) => searchFile(`Notes/foo-${i}.md`));
		const app = new App();
		app.vault.getMarkdownFiles = () => files;
		app.vault.cachedRead = async () => 'body';
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'foo' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.autoBody).toBeUndefined();
	});
});

describe('search_vault — heading context on content hits', () => {
	it('content hit includes heading + startLine + endLine of the enclosing section', async () => {
		const content = [
			'# Top',                  // line 1
			'',                       // line 2
			'## Setup',               // line 3
			'do this and that',       // line 4
			'install the package',    // line 5 (target line: "package" matches)
			'',
			'## Running',             // line 7
			'run it',
		].join('\n');
		const file = searchFile('a.md', content);
		const app = new App();
		app.vault.getMarkdownFiles = () => [file];
		app.vault.cachedRead = async () => content;
		app.metadataCache.getFileCache = () => ({
			headings: [
				{ heading: 'Top', level: 1, position: { start: { line: 0 } } },
				{ heading: 'Setup', level: 2, position: { start: { line: 2 } } },
				{ heading: 'Running', level: 2, position: { start: { line: 6 } } },
			],
		});
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'install package', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		const contentHit = parsed.results[0].hits.find((h: { in: string }) => h.in === 'content');
		expect(contentHit).toBeTruthy();
		expect(contentHit.heading).toBe('Setup');
		expect(contentHit.startLine).toBe(3);
		// Setup section runs up to (but not including) the Running heading on line 7.
		expect(contentHit.endLine).toBe(6);
	});
});

describe('search_vault — stopword tolerance', () => {
	it('natural-language query matches the significant phrase even with filler words', async () => {
		const target = searchFile('Notes/Improv.md', 'today I learned about support characters in scenes');
		const app = new App();
		app.vault.getMarkdownFiles = () => [target];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'where did I write about support characters', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Notes/Improv.md');
	});

	it('all-stopword/short query (A to C) requires the literal phrase, not bag-of-words', async () => {
		// A note with "A to C" gets a hit. A note containing a, to, c separately
		// (in different positions) does NOT pass the phrase gate.
		const phraseFile = searchFile('Notes/AC.md', 'practiced the A to C progression');
		const scatteredFile = searchFile(
			'Notes/Random.md',
			'a goal: get to the c-suite by year end',
		);
		const app = new App();
		app.vault.getMarkdownFiles = () => [phraseFile, scatteredFile];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'A to C', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		const paths = parsed.results.map((r: { path: string }) => r.path);
		expect(paths).toContain('Notes/AC.md');
		expect(paths).not.toContain('Notes/Random.md');
	});
});

describe('search_vault — hyphen / punctuation normalization', () => {
	it('matches "deep-work", "deep_work", "deep work" interchangeably in body scan', async () => {
		const hyphen = searchFile('h.md', 'today I focused on deep-work all morning');
		const under = searchFile('u.md', 'tracking my deep_work hours this week');
		const space = searchFile('s.md', 'committed to deep work blocks daily');
		const app = new App();
		app.vault.getMarkdownFiles = () => [hyphen, under, space];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		for (const q of ['deep-work', 'deep_work', 'deep work']) {
			const out = await dispatchTool(TOOLS, 'search_vault', { query: q, deepSearch: true }, app, 'Meta');
			const parsed = JSON.parse(out);
			const paths = parsed.results.map((r: { path: string }) => r.path).sort();
			expect(paths).toEqual(['h.md', 's.md', 'u.md']);
		}
	});
});

describe('search_vault — BM25 IDF over scanned corpus', () => {
	it('rare term contributes more than common term to score', async () => {
		// "eventual" appears in 1/4 docs (rare), "consistency" in 3/4 (common).
		// The doc with BOTH and where "eventual" is densely present should rank
		// above a doc that just repeats "consistency".
		const both = searchFile('both.md', 'eventual consistency model used in distributed systems');
		const commonHeavy = searchFile(
			'common.md',
			'consistency consistency consistency consistency consistency in code review',
		);
		const commonOnly = searchFile('c1.md', 'team consistency in coding style');
		const commonOnly2 = searchFile('c2.md', 'workflow consistency matters');
		const app = new App();
		app.vault.getMarkdownFiles = () => [both, commonHeavy, commonOnly, commonOnly2];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'eventual consistency', deepSearch: true },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		// Both must rank above the consistency-only files.
		expect(parsed.results[0].path).toBe('both.md');
	});
});

describe('search_vault — RRF: fuzzy as last resort only', () => {
	it('fuzzy does NOT fire when a content scan already produced a hit', async () => {
		// Regression: with fuzzy threshold > 1, "thou art" would fuzzy-match
		// "The Four Agreements" via character scatter even though the body
		// already contained the literal phrase.
		const target = searchFile('Areas/Improv/Mid Show.md', '"Thou art..." it has become a god');
		const noise = searchFile('Resources/The Four Agreements.md', 'unrelated content');
		const app = new App();
		app.vault.getMarkdownFiles = () => [target, noise];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'thou art' },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.fuzzyFallback).toBeUndefined();
		const paths = parsed.results.map((r: { path: string }) => r.path);
		expect(paths).toEqual(['Areas/Improv/Mid Show.md']);
	});

	it('fuzzy still catches a typo when nothing else matched (auto-body included)', async () => {
		const target = searchFile('Improv Openings.md');
		const app = new App();
		app.vault.getMarkdownFiles = () => [target];
		app.vault.cachedRead = async () => ''; // no body match
		app.metadataCache.getFileCache = () => null;
		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'imrov' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.fuzzyFallback).toBe(true);
		expect(parsed.results[0].path).toBe('Improv Openings.md');
	});
});

describe('allocation-light counters (memory hot path)', () => {
	it('countWords matches split(/\\s+/) for typical text', () => {
		const samples = [
			'the quick brown fox',
			'  leading and trailing  ',
			'tabs\tand\tspaces',
			'lines\nseparated\nby\nnewlines',
			'',
			'one',
			'multiple   internal   spaces',
		];
		for (const s of samples) {
			const reference = s.split(/\s+/).filter(Boolean).length;
			expect(countWords(s)).toBe(reference);
		}
	});

	it('countNewlines counts \\n without allocation', () => {
		expect(countNewlines('one\ntwo\nthree')).toBe(2);
		expect(countNewlines('no newlines')).toBe(0);
		expect(countNewlines('')).toBe(0);
		expect(countNewlines('\n\n\n')).toBe(3);
		expect(countNewlines('one\ntwo\nthree', 4)).toBe(1);
	});

	it('countWordOccurrencesNormalized matches old .match() semantics', () => {
		// Sanity: same result, just without allocating the match array.
		const normalized = normalizeForMatch('foo and foo and foo bar foo');
		expect(countWordOccurrencesNormalized(normalized, 'foo')).toBe(4);
		expect(countWordOccurrencesNormalized(normalized, 'bar')).toBe(1);
		expect(countWordOccurrencesNormalized(normalized, 'baz')).toBe(0);
	});

	it('findWordMatchesNormalized line numbers stay correct across many matches', () => {
		// Stress the incremental line tracking — prior implementation allocated
		// a prefix slice + split per match, this one walks once.
		const lines: string[] = [];
		for (let i = 1; i <= 50; i++) {
			lines.push(i % 5 === 0 ? `line ${i} mentions target here` : `line ${i} filler`);
		}
		const content = lines.join('\n');
		const matches = findWordMatchesNormalized(content, normalizeForMatch(content), 'target', 10);
		// Every 5th line: 5, 10, 15, ... so first 10 hits are lines 5, 10, ..., 50.
		expect(matches.length).toBe(10);
		expect(matches[0].line).toBe(5);
		expect(matches[1].line).toBe(10);
		expect(matches[9].line).toBe(50);
	});
});

describe('search_vault — auto-body content scan does not retain bodies', () => {
	it('does not hold simultaneous content + normalized strings across the whole scan', async () => {
		// Behavioural proxy for "release per file": cachedRead must be called
		// at most once per file even though both content + normalized are
		// derived from it. (The old implementation also called it once — the
		// real win is that we now release strings between iterations, which
		// JavaScript can't observe directly, so we lean on tests that
		// surrounding behaviour is unchanged plus this sanity check.)
		const files = Array.from({ length: 50 }, (_, i) =>
			searchFile(`Notes/${i}.md`, `body line one for note ${i}\n## H\nfoo here in note ${i}`),
		);
		const readCount = new Map<string, number>();
		const app = new App();
		app.vault.getMarkdownFiles = () => files;
		app.vault.cachedRead = async (f: TFile) => {
			readCount.set(f.path, (readCount.get(f.path) ?? 0) + 1);
			return (f as TFile & { __content: string }).__content;
		};
		app.metadataCache.getFileCache = () => ({
			headings: [{ heading: 'H', level: 2, position: { start: { line: 1 } } }],
		});

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'foo', deepSearch: true }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(50);
		for (const c of readCount.values()) expect(c).toBeLessThanOrEqual(1);

		// Sanity: content hit retained heading enclosure even though strings
		// were released after pass 1.
		const contentHit = parsed.results[0].hits.find((h: { in: string }) => h.in === 'content');
		expect(contentHit.heading).toBe('H');
	});
});

describe('search_vault — tool description', () => {
	it('mentions every surface name so Agent B knows what query can match', () => {
		const tool = TOOLS.find((t) => t.name === 'search_vault')!;
		const desc = tool.description;
		for (const surface of ['filename', 'alias', 'heading', 'tag', 'linkDisplayText', 'content']) {
			expect(desc).toContain(surface);
		}
		// Self-correction signals
		expect(desc).toContain('autoBody');
		expect(desc).toContain('fuzzyFallback');
		expect(desc).toContain('matchedSurfaces');
	});

	it('documents that Obsidian Excluded files are skipped', () => {
		const tool = TOOLS.find((t) => t.name === 'search_vault')!;
		expect(tool.description.toLowerCase()).toContain('excluded files');
	});
});

// ---------- userIgnoreFilters (Obsidian Settings → Files and links → Excluded files) ----------

describe('matchesIgnoreFilter', () => {
	it('bare name matches the folder and its descendants on segment boundaries', () => {
		expect(matchesIgnoreFilter('Archive', 'Archive')).toBe(true);
		expect(matchesIgnoreFilter('Archive', 'Archive/foo.md')).toBe(true);
		expect(matchesIgnoreFilter('Archive', 'Archive/Sub/foo.md')).toBe(true);
		// Segment boundary — Archived is a different folder.
		expect(matchesIgnoreFilter('Archive', 'Archived/foo.md')).toBe(false);
		// Different roots don't match.
		expect(matchesIgnoreFilter('Archive', 'Notes/Archive-talk.md')).toBe(false);
	});

	it('trailing-slash form matches a folder and its descendants', () => {
		expect(matchesIgnoreFilter('Archive/', 'Archive')).toBe(true);
		expect(matchesIgnoreFilter('Archive/', 'Archive/foo.md')).toBe(true);
		expect(matchesIgnoreFilter('Archive/', 'Archived/foo.md')).toBe(false);
	});

	it('glob form (Archive/**) matches recursively', () => {
		expect(matchesIgnoreFilter('Archive/**', 'Archive')).toBe(true);
		expect(matchesIgnoreFilter('Archive/**', 'Archive/foo.md')).toBe(true);
		expect(matchesIgnoreFilter('Archive/**', 'Archive/Sub/foo.md')).toBe(true);
		expect(matchesIgnoreFilter('Archive/**', 'Archived/foo.md')).toBe(false);
	});

	it('regex form (/.../) honors arbitrary JS regex against the full path', () => {
		expect(matchesIgnoreFilter('/^Archive\\/.*\\.md$/', 'Archive/foo.md')).toBe(true);
		expect(matchesIgnoreFilter('/^Archive\\/.*\\.md$/', 'Notes/foo.md')).toBe(false);
		// Malformed regex doesn't crash, just doesn't match.
		expect(matchesIgnoreFilter('/[unterminated/', 'anything')).toBe(false);
	});

	it('exact file path matches that file only', () => {
		expect(matchesIgnoreFilter('Notes/secret.md', 'Notes/secret.md')).toBe(true);
		expect(matchesIgnoreFilter('Notes/secret.md', 'Notes/secret-other.md')).toBe(false);
	});

	it('empty filter never matches', () => {
		expect(matchesIgnoreFilter('', 'anything')).toBe(false);
	});
});

describe('getUserIgnoreFilters', () => {
	it('returns an empty list when the field is absent', () => {
		const app = new App();
		expect(getUserIgnoreFilters(app)).toEqual([]);
	});

	it('reads app.vault.config.userIgnoreFilters when present', () => {
		const app = new App();
		(app.vault as unknown as { config: { userIgnoreFilters: unknown[] } }).config = {
			userIgnoreFilters: ['Archive/', 'Templates/**', '', 42, null],
		};
		// Strings only, empty strings dropped.
		expect(getUserIgnoreFilters(app)).toEqual(['Archive/', 'Templates/**']);
	});
});

describe('isUserIgnored', () => {
	it('returns true if any filter matches', () => {
		expect(isUserIgnored(['Archive/', 'Templates/**'], 'Templates/daily.md')).toBe(true);
		expect(isUserIgnored(['Archive/', 'Templates/**'], 'Notes/foo.md')).toBe(false);
	});
});

// ---------- ignore-filter integration into search_vault / list_recent / get_backlinks ----------

function appWithIgnoreFilters(filters: string[]): App {
	const app = new App();
	(app.vault as unknown as { config: { userIgnoreFilters: string[] } }).config = {
		userIgnoreFilters: filters,
	};
	return app;
}

describe('search_vault — userIgnoreFilters integration', () => {
	it('skips files matching an Excluded Files entry by default', async () => {
		const archived = Object.assign(new TFile(), {
			path: 'Archive/old.md',
			basename: 'old',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const live = Object.assign(new TFile(), {
			path: 'Notes/old.md',
			basename: 'old',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const app = appWithIgnoreFilters(['Archive/']);
		app.vault.getMarkdownFiles = () => [archived, live];
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'old' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Notes/old.md');
	});

	it('defers exclusion when pathPrefix points at the excluded root', async () => {
		const archived = Object.assign(new TFile(), {
			path: 'Archive/old.md',
			basename: 'old',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const live = Object.assign(new TFile(), {
			path: 'Notes/old.md',
			basename: 'old',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const app = appWithIgnoreFilters(['Archive/']);
		app.vault.getMarkdownFiles = () => [archived, live];
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'old', pathPrefix: 'Archive' },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		// pathPrefix at the excluded root overrides — Archive/old.md is visible,
		// Notes/old.md is filtered out by the pathPrefix itself.
		expect(parsed.matches).toBe(1);
		expect(parsed.results[0].path).toBe('Archive/old.md');
	});

	it('defers exclusion when pathPrefix is a subfolder of the excluded root', async () => {
		const nested = Object.assign(new TFile(), {
			path: 'Archive/MOCs/old.md',
			basename: 'old',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const app = appWithIgnoreFilters(['Archive/']);
		app.vault.getMarkdownFiles = () => [nested];
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(
			TOOLS,
			'search_vault',
			{ query: 'old', pathPrefix: 'Archive/MOCs' },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
	});

	it('does nothing when there are no userIgnoreFilters configured', async () => {
		const archived = Object.assign(new TFile(), {
			path: 'Archive/old.md',
			basename: 'old',
			extension: 'md',
			stat: { mtime: 100, ctime: 0, size: 10 },
		});
		const app = new App(); // no .vault.config
		app.vault.getMarkdownFiles = () => [archived];
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'old' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.matches).toBe(1);
	});
});

describe('list_recent — userIgnoreFilters integration', () => {
	it('skips files matching an Excluded Files entry by default', async () => {
		const archived = Object.assign(new TFile(), { path: 'Archive/a.md', basename: 'a', extension: 'md', stat: { mtime: 200, ctime: 0, size: 0 } });
		const live = Object.assign(new TFile(), { path: 'Notes/b.md', basename: 'b', extension: 'md', stat: { mtime: 100, ctime: 0, size: 0 } });
		const app = appWithIgnoreFilters(['Archive/']);
		app.vault.getMarkdownFiles = () => [archived, live];

		const out = await dispatchTool(TOOLS, 'list_recent', {}, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.count).toBe(1);
		expect(parsed.results[0].path).toBe('Notes/b.md');
	});

	it('defers exclusion when pathPrefix points at the excluded root', async () => {
		const archived = Object.assign(new TFile(), { path: 'Archive/a.md', basename: 'a', extension: 'md', stat: { mtime: 200, ctime: 0, size: 0 } });
		const app = appWithIgnoreFilters(['Archive/']);
		app.vault.getMarkdownFiles = () => [archived];

		const out = await dispatchTool(TOOLS, 'list_recent', { pathPrefix: 'Archive' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.count).toBe(1);
		expect(parsed.results[0].path).toBe('Archive/a.md');
	});
});

describe('get_backlinks — userIgnoreFilters integration', () => {
	it('skips source links from excluded folders', async () => {
		const app = appWithIgnoreFilters(['Archive/']);
		app.metadataCache.resolvedLinks = {
			'Archive/old.md': { 'target.md': 5 },
			'Notes/live.md': { 'target.md': 1 },
		};
		const out = await dispatchTool(TOOLS, 'get_backlinks', { path: 'target.md' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.count).toBe(1);
		expect(parsed.results[0].path).toBe('Notes/live.md');
	});

	it('returns archived sources when no filters are configured', async () => {
		const app = new App();
		app.metadataCache.resolvedLinks = {
			'Archive/old.md': { 'target.md': 5 },
			'Notes/live.md': { 'target.md': 1 },
		};
		const out = await dispatchTool(TOOLS, 'get_backlinks', { path: 'target.md' }, app, 'Meta');
		const parsed = JSON.parse(out);
		expect(parsed.count).toBe(2);
	});
});
