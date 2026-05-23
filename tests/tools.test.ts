import { describe, expect, it } from 'vitest';
import {
	dispatchTool,
	emptyHint,
	findContentMatches,
	findSectionIndex,
	LOAD_SKILL_NAME,
	matchesPathPrefix,
	normalizePathPrefix,
	normalizeTag,
	pathGuard,
	stripDuplicateTitleHeading,
	TOOLS,
	toolsToOpenAI,
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

	it('blocks metaDir/chats and metaDir/.smart-aide for any metaDir', () => {
		expect(pathGuard('Meta/chats/x.jsonl', 'Meta')).toMatch(/chats/);
		expect(pathGuard('Meta/.smart-aide/x', 'Meta')).toMatch(/plugin internal/);
	});

	it('blocks chats / internal even when metaDir has a trailing slash', () => {
		// The fix from v0.1.16: a "sys/" metaDir used to produce "sys//chats/" guard
		// prefixes that vault-relative paths didn't match. pathGuard now normalizes.
		expect(pathGuard('sys/chats/x.jsonl', 'sys/')).toMatch(/chats/);
		expect(pathGuard('sys/.smart-aide/x', 'sys/')).toMatch(/plugin internal/);
	});

	it('blocks the metaDir/chats and metaDir/.smart-aide folders themselves', () => {
		expect(pathGuard('Meta/chats', 'Meta')).toMatch(/chats/);
		expect(pathGuard('Meta/.smart-aide', 'Meta')).toMatch(/plugin internal/);
	});

	it('does not overmatch sibling folders that share a prefix', () => {
		// "MetaNotes" should not be blocked just because metaDir is "Meta".
		expect(pathGuard('MetaNotes/a.md', 'Meta')).toBe('');
	});

	it('allows ordinary notes', () => {
		expect(pathGuard('Daily/2026-05-23.md', 'Meta')).toBe('');
		expect(pathGuard('Meta/AGENTS.md', 'Meta')).toBe('');
		expect(pathGuard('Meta/skills/foo.md', 'Meta')).toBe('');
	});

	it('enforces .md when requireMarkdown is set', () => {
		expect(pathGuard('Notes/foo.png', 'Meta', { requireMarkdown: true })).toMatch(/.md/);
		expect(pathGuard('Notes/foo.MD', 'Meta', { requireMarkdown: true })).toBe('');
		expect(pathGuard('Notes/foo.md', 'Meta', { requireMarkdown: true })).toBe('');
	});

	it('blocks chats/internal even when requireMarkdown is set (forbidden wins)', () => {
		// A reader passing requireMarkdown: true on Meta/chats/x.jsonl should hit
		// the chats-forbidden error, not the markdown error.
		expect(pathGuard('Meta/chats/x.jsonl', 'Meta', { requireMarkdown: true })).toMatch(/chats/);
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

// ---------- findContentMatches ----------

describe('findContentMatches', () => {
	it('returns line + snippet for each occurrence up to the cap', () => {
		const content = ['alpha', 'this has FOO in it', 'middle', 'foo again here', 'foo once more'].join('\n');
		const results = findContentMatches(content, 'foo', 2);
		expect(results).toHaveLength(2);
		expect(results[0].line).toBe(2);
		expect(results[0].snippet.toLowerCase()).toContain('foo');
		expect(results[1].line).toBe(4);
	});

	it('returns empty when no match', () => {
		expect(findContentMatches('hello world', 'xyz', 5)).toEqual([]);
	});

	it('handles a single-line file', () => {
		const out = findContentMatches('foo bar baz', 'bar', 5);
		expect(out).toHaveLength(1);
		expect(out[0].line).toBe(1);
	});

	it('uses leading ellipsis when the match is past the snippet padding window', () => {
		const long = 'x'.repeat(100) + ' MATCH ' + 'y'.repeat(100);
		const out = findContentMatches(long, 'match', 1);
		expect(out[0].snippet.startsWith('…')).toBe(true);
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

	it('rejects reads of chats/', async () => {
		const app = new App();
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'Meta/chats/x.jsonl' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/chats/);
	});

	it('rejects reads of plugin internals', async () => {
		const app = new App();
		const out = await dispatchTool(TOOLS, 'read_note', { path: 'Meta/.smart-aide/foo' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/plugin internal/);
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

	it('refuses to write into chats/', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'write_note', { path: 'Meta/chats/a.jsonl', content: 'x' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/chats/);
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
		const out = await dispatchTool(TOOLS, 'append_to_note', { path: 'Meta/.smart-aide/x', content: 'x' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/plugin internal/);
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

	it('refuses to delete chats/', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(TOOLS, 'delete_note', { path: 'Meta/chats/a.jsonl' }, app, 'Meta');
		expect(JSON.parse(out).error).toMatch(/chats/);
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

	it('deepSearch only scans files without a metadata match', async () => {
		const filenameMatch = tfile('foo.md', 'this body also has foo');
		const bodyOnly = tfile('other.md', 'a long body that mentions foo deep inside');
		(filenameMatch as TFile & { __content: string }).__content = 'this body also has foo';
		(bodyOnly as TFile & { __content: string }).__content = 'a long body that mentions foo deep inside';

		const app = new App();
		app.vault.getMarkdownFiles = () => [filenameMatch, bodyOnly];
		app.vault.cachedRead = async (f: TFile) => (f as TFile & { __content: string }).__content;
		app.metadataCache.getFileCache = () => null;

		const out = await dispatchTool(TOOLS, 'search_vault', { query: 'foo', deepSearch: true }, app, 'Meta');
		const parsed = JSON.parse(out);
		// Both files should be in the result set.
		expect(parsed.matches).toBe(2);
		const filenameResult = parsed.results.find((r: { path: string }) => r.path === 'foo.md');
		const bodyResult = parsed.results.find((r: { path: string }) => r.path === 'other.md');
		// filenameMatch only has a filename hit (no content scan since it was bucketed).
		expect(filenameResult.hits.every((h: { in: string }) => h.in === 'filename')).toBe(true);
		// bodyOnly only has a content hit.
		expect(bodyResult.hits.some((h: { in: string }) => h.in === 'content')).toBe(true);
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
});

describe('load_skill default execute', () => {
	it('returns an error pointing to view-level dispatch (the default body)', async () => {
		const out = await dispatchTool(TOOLS, LOAD_SKILL_NAME, { name: 'whatever' }, new App(), 'Meta');
		expect(JSON.parse(out).error).toMatch(/dispatched through the view/);
	});
});

describe('toolsToOpenAI', () => {
	it('wraps each tool as an OpenAI function-type definition', () => {
		const out = toolsToOpenAI(TOOLS);
		expect(out.length).toBe(TOOLS.length);
		for (const t of out) {
			expect(t.type).toBe('function');
			expect(typeof t.function.name).toBe('string');
			expect(typeof t.function.description).toBe('string');
			expect(t.function.parameters).toBeTruthy();
		}
		const names = out.map((t) => t.function.name);
		expect(names).toContain('search_vault');
		expect(names).toContain('read_note');
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
