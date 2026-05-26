import { describe, expect, it } from 'vitest';
import { App, TFile } from 'obsidian';
import {
	appendBulletToSection,
	dispatchTool,
	formatMemoryBullet,
	MEMORY_SECTIONS,
	TOOLS,
} from '../src/tools';
import type { Tool } from '../src/types';

describe('formatMemoryBullet', () => {
	it('prepends today\'s date and the bullet marker', () => {
		const today = new Date().toISOString().slice(0, 10);
		expect(formatMemoryBullet('Prefers Go')).toBe(`- ${today}: Prefers Go`);
	});

	it('strips a leading bullet character the model might add', () => {
		const today = new Date().toISOString().slice(0, 10);
		// Models trained on markdown sometimes lead with "- " — we re-add it
		// uniformly so the file stays consistent and dated.
		expect(formatMemoryBullet('- foo')).toBe(`- ${today}: foo`);
		expect(formatMemoryBullet('* foo')).toBe(`- ${today}: foo`);
	});

	it('trims surrounding whitespace from content', () => {
		const today = new Date().toISOString().slice(0, 10);
		expect(formatMemoryBullet('  spaced  ')).toBe(`- ${today}: spaced`);
	});
});

describe('appendBulletToSection', () => {
	it('creates the section + bullet when the file is empty', () => {
		const out = appendBulletToSection('', 'Preferences', '- 2026-05-26: x');
		expect(out).toBe('## Preferences\n\n- 2026-05-26: x\n');
	});

	it('appends a new section at the end when the section is absent', () => {
		const current = '## Profile\n\n- 2026-05-20: existing\n';
		const out = appendBulletToSection(current, 'Decisions', '- 2026-05-26: new');
		expect(out).toContain('## Profile');
		expect(out).toContain('## Decisions\n\n- 2026-05-26: new');
		// Existing section preserved untouched
		expect(out).toContain('- 2026-05-20: existing');
		// New section appears after the existing one (append, not prepend)
		expect(out.indexOf('## Profile')).toBeLessThan(out.indexOf('## Decisions'));
	});

	it('appends the bullet into an existing section without disturbing other sections', () => {
		const current = [
			'## Profile',
			'',
			'- 2026-05-20: p1',
			'',
			'## Preferences',
			'',
			'- 2026-05-21: pref1',
			'',
			'## Decisions',
			'',
			'- 2026-05-22: d1',
			'',
		].join('\n');
		const out = appendBulletToSection(current, 'Preferences', '- 2026-05-26: pref2');
		expect(out).toContain('- 2026-05-21: pref1');
		expect(out).toContain('- 2026-05-26: pref2');
		// The new bullet sits inside Preferences, not after Decisions
		const prefIdx = out.indexOf('## Preferences');
		const decIdx = out.indexOf('## Decisions');
		const newIdx = out.indexOf('- 2026-05-26: pref2');
		expect(newIdx).toBeGreaterThan(prefIdx);
		expect(newIdx).toBeLessThan(decIdx);
		// Other sections still present
		expect(out).toContain('- 2026-05-20: p1');
		expect(out).toContain('- 2026-05-22: d1');
	});

	it('appends inside a trailing section (last section, no following heading)', () => {
		const current = '## Profile\n\n- 2026-05-20: p1\n';
		const out = appendBulletToSection(current, 'Profile', '- 2026-05-26: p2');
		expect(out).toContain('- 2026-05-20: p1');
		expect(out).toContain('- 2026-05-26: p2');
		// The newer bullet comes after the older one
		expect(out.indexOf('- 2026-05-20: p1')).toBeLessThan(out.indexOf('- 2026-05-26: p2'));
	});

	it('exposes the fixed section taxonomy', () => {
		// Pinned shape — adding/removing sections is a contract change.
		expect(MEMORY_SECTIONS).toEqual([
			'Profile',
			'Preferences',
			'Decisions',
			'Projects',
			'People',
			'References',
		]);
	});
});

function tfile(path: string, content = ''): TFile {
	const f = Object.assign(new TFile(), {
		path,
		name: path.split('/').pop(),
		basename: (path.split('/').pop() ?? '').replace(/\.md$/, ''),
		extension: 'md',
		stat: { mtime: 0, ctime: 0, size: content.length },
	});
	(f as TFile & { __content: string }).__content = content;
	return f;
}

function appWithFiles(files: TFile[]): App & { __created: () => Record<string, string> } {
	const app = new App();
	const created: Record<string, string> = {};
	app.vault.getFileByPath = (p: string) => files.find((f) => f.path === p) ?? null;
	app.vault.read = async (f: TFile) => (f as TFile & { __content?: string }).__content ?? '';
	app.vault.cachedRead = app.vault.read;
	app.vault.adapter = { exists: async (p: string) => files.some((f) => f.path === p || f.path.startsWith(p + '/')) };
	app.vault.create = async (path: string, content: string) => {
		created[path] = content;
		const f = tfile(path, content);
		files.push(f);
		return f;
	};
	app.vault.createFolder = async () => undefined;
	app.vault.process = async (f: TFile, fn: (c: string) => string) => {
		(f as TFile & { __content?: string }).__content = fn((f as TFile & { __content?: string }).__content ?? '');
	};
	return Object.assign(app, { __created: () => created });
}

describe('save_memory tool', () => {
	const memoryPath = 'Meta/Smart Aide/memory.md';

	it('creates memory.md when the file is absent (first save)', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(
			TOOLS,
			'save_memory',
			{ section: 'Preferences', content: 'No trailing summaries.' },
			app,
			'Meta',
		);
		const parsed = JSON.parse(out);
		expect(parsed.status).toBe('remembered');
		expect(parsed.path).toBe(memoryPath);
		expect(parsed.created).toBe(true);
		const created = app.__created()[memoryPath];
		expect(created).toContain('## Preferences');
		expect(created).toContain('No trailing summaries.');
		// Date prefix gets applied
		const today = new Date().toISOString().slice(0, 10);
		expect(created).toContain(today);
	});

	it('appends inside an existing section on a subsequent save', async () => {
		const initial = '## Preferences\n\n- 2026-05-20: first\n';
		const file = tfile(memoryPath, initial);
		const app = appWithFiles([file]);
		const out = await dispatchTool(
			TOOLS,
			'save_memory',
			{ section: 'Preferences', content: 'second' },
			app,
			'Meta',
		);
		expect(JSON.parse(out).status).toBe('remembered');
		const final = (file as TFile & { __content: string }).__content;
		expect(final).toContain('- 2026-05-20: first');
		expect(final).toContain('second');
	});

	it('rejects sections outside the fixed taxonomy', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(
			TOOLS,
			'save_memory',
			{ section: 'Misc', content: 'whatever' },
			app,
			'Meta',
		);
		expect(JSON.parse(out).error).toMatch(/Profile, Preferences/);
	});

	it('rejects empty content', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(
			TOOLS,
			'save_memory',
			{ section: 'Preferences', content: '   ' },
			app,
			'Meta',
		);
		expect(JSON.parse(out).error).toMatch(/content is required/);
	});

	it('preview shows the dated bullet that will be appended', async () => {
		const file = tfile(memoryPath, '## Preferences\n\n- 2026-05-20: first\n');
		const app = appWithFiles([file]);
		const tool = TOOLS.find((t: Tool) => t.name === 'save_memory')!;
		const preview = await tool.preview!(
			{ section: 'Preferences', content: 'second' },
			{ app, metaDir: 'Meta' },
		);
		expect(preview.summary).toBe('Remember in Preferences');
		expect(preview.diff?.kind).toBe('append');
		expect(preview.diff?.path).toBe(memoryPath);
		const today = new Date().toISOString().slice(0, 10);
		expect(preview.diff?.newContent).toBe(`- ${today}: second`);
	});

	it('preview surfaces validation failures in the summary instead of an empty diff', async () => {
		const app = appWithFiles([]);
		const tool = TOOLS.find((t: Tool) => t.name === 'save_memory')!;
		const preview = await tool.preview!(
			{ section: 'Misc', content: 'x' },
			{ app, metaDir: 'Meta' },
		);
		expect(preview.summary).toMatch(/Profile, Preferences/);
		expect(preview.diff).toBeUndefined();
	});

	it('respects a non-default metaDir', async () => {
		const app = appWithFiles([]);
		const out = await dispatchTool(
			TOOLS,
			'save_memory',
			{ section: 'Preferences', content: 'foo' },
			app,
			'sys',
		);
		const parsed = JSON.parse(out);
		expect(parsed.path).toBe('sys/Smart Aide/memory.md');
	});

	it('exposes save_memory in the public TOOLS array', () => {
		// Smoke check: an external caller wiring tool descriptors should find
		// save_memory, since the model can\'t learn the tool without a descriptor.
		const names = TOOLS.map((t) => t.name);
		expect(names).toContain('save_memory');
	});
});
