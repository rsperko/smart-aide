import { beforeEach, describe, expect, it } from 'vitest';
import { App, Platform, TFile, TFolder, Vault } from 'obsidian';
import { listField, parseSkillContent, scalarField, SkillRegistry } from '../src/skills';

describe('scalarField', () => {
	it('reads a bare value', () => {
		expect(scalarField('name: foo\ndescription: bar', 'name')).toBe('foo');
	});

	it('strips matching single and double quotes', () => {
		expect(scalarField('name: "Quoted"\n', 'name')).toBe('Quoted');
		expect(scalarField("name: 'Quoted'\n", 'name')).toBe('Quoted');
	});

	it('returns empty for a missing key', () => {
		expect(scalarField('name: foo', 'missing')).toBe('');
	});

	it('is case-insensitive on the key', () => {
		expect(scalarField('Name: foo', 'name')).toBe('foo');
	});
});

describe('parseSkillContent', () => {
	it('parses name + description + body', () => {
		const md = '---\nname: note-capture\ndescription: capture notes\n---\nBody here';
		const skill = parseSkillContent(md, 'Meta/skills/note-capture.md');
		expect(skill).not.toBeNull();
		expect(skill!.name).toBe('note-capture');
		expect(skill!.description).toBe('capture notes');
		expect(skill!.body).toBe('Body here');
		expect(skill!.mobile).toBe(true);
	});

	it('returns null when frontmatter is missing', () => {
		expect(parseSkillContent('just body, no fm', 'a.md')).toBeNull();
	});

	it('returns null when name or description is missing', () => {
		const md = '---\nname: only-name\n---\nbody';
		expect(parseSkillContent(md, 'a.md')).toBeNull();
	});

	it('honors `mobile: false` to flag a desktop-only skill', () => {
		const md = '---\nname: desk\ndescription: d\nmobile: false\n---\nbody';
		const skill = parseSkillContent(md, 'a.md');
		expect(skill!.mobile).toBe(false);
	});

	it('defaults user-invocable to false and allowed-tools to null when absent', () => {
		const md = '---\nname: x\ndescription: d\n---\nbody';
		const skill = parseSkillContent(md, 'a.md');
		expect(skill!.userInvocable).toBe(false);
		expect(skill!.allowedTools).toBeNull();
	});

	it('reads user-invocable: true (case-insensitive)', () => {
		const md = '---\nname: x\ndescription: d\nuser-invocable: True\n---\nbody';
		const skill = parseSkillContent(md, 'a.md');
		expect(skill!.userInvocable).toBe(true);
	});

	it('reads flow-style allowed-tools', () => {
		const md =
			'---\nname: x\ndescription: d\nuser-invocable: true\nallowed-tools: [read_note, write_note]\n---\nbody';
		const skill = parseSkillContent(md, 'a.md');
		expect(skill!.allowedTools).toEqual(['read_note', 'write_note']);
	});

	it('reads block-style allowed-tools', () => {
		const md =
			'---\nname: x\ndescription: d\nallowed-tools:\n  - read_note\n  - write_note\n  - search_vault\n---\nbody';
		const skill = parseSkillContent(md, 'a.md');
		expect(skill!.allowedTools).toEqual(['read_note', 'write_note', 'search_vault']);
	});

	it('strips quotes around list items', () => {
		const md = `---\nname: x\ndescription: d\nallowed-tools: ["read_note", 'write_note']\n---\nbody`;
		const skill = parseSkillContent(md, 'a.md');
		expect(skill!.allowedTools).toEqual(['read_note', 'write_note']);
	});
});

describe('listField', () => {
	it('returns null when the key is missing', () => {
		expect(listField('name: x\n', 'allowed-tools')).toBeNull();
	});

	it('returns [] for an empty flow list', () => {
		expect(listField('allowed-tools: []\n', 'allowed-tools')).toEqual([]);
	});
});

// ---------- SkillRegistry ----------

class MiniVault extends Vault {
	files = new Map<string, string>();
	folders = new Map<string, TFolder>();

	getAbstractFileByPath(path: string): TFolder | TFile | null {
		if (this.folders.has(path)) return this.folders.get(path)!;
		if (this.files.has(path)) {
			const f = new TFile();
			f.path = path;
			f.extension = 'md';
			f.basename = (path.split('/').pop() ?? '').replace(/\.md$/, '');
			return f;
		}
		return null;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? '';
	}

	addFile(path: string, content: string): TFile {
		this.files.set(path, content);
		return this.getAbstractFileByPath(path) as TFile;
	}

	addFolder(path: string): TFolder {
		const folder = new TFolder();
		folder.path = path;
		folder.name = path.split('/').pop() ?? path;
		folder.children = [];
		this.folders.set(path, folder);
		return folder;
	}
}

function attachToFolder(folder: TFolder, child: TFile | TFolder): void {
	child.parent = folder;
	folder.children.push(child);
}

describe('SkillRegistry', () => {
	let vault: MiniVault;
	let app: App;

	beforeEach(() => {
		Platform.isMobile = false;
		vault = new MiniVault();
		app = new App();
		app.vault = vault as unknown as Vault;
	});

	it('reads a flat single-file skill', async () => {
		const folder = vault.addFolder('Meta/skills');
		const file = vault.addFile('Meta/skills/note-capture.md', '---\nname: note-capture\ndescription: capture\n---\nbody');
		attachToFolder(folder, file);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();
		const all = registry.all();
		expect(all).toHaveLength(1);
		expect(all[0].name).toBe('note-capture');
	});

	// Regression for the 0.3.0 race where plugin onload ran before
	// Obsidian had indexed the vault, leaving the skills registry empty
	// and the slash popover silent. The fix moved load() to onLayoutReady,
	// but load() itself must still gracefully no-op (not throw) when the
	// folder isn't present in the vault tree.
	it('load() returns empty when the skills folder is not in the vault tree', async () => {
		const registry = new SkillRegistry(app, 'sys/skills');
		await registry.load();
		expect(registry.all()).toEqual([]);
		expect(registry.userInvocableSkills()).toEqual([]);
	});

	it('load() can be called twice and replaces the previous result', async () => {
		const folder = vault.addFolder('Meta/skills');
		const file = vault.addFile(
			'Meta/skills/a.md',
			'---\nname: a\ndescription: first\n---\n',
		);
		attachToFolder(folder, file);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();
		expect(registry.all().map((s) => s.name)).toEqual(['a']);

		const file2 = vault.addFile(
			'Meta/skills/b.md',
			'---\nname: b\ndescription: second\n---\n',
		);
		attachToFolder(folder, file2);
		await registry.load();
		expect(registry.all().map((s) => s.name)).toEqual(['a', 'b']);
	});

	it('reads a SKILL.md inside a subfolder', async () => {
		const root = vault.addFolder('Meta/skills');
		const sub = vault.addFolder('Meta/skills/my-skill');
		const skillFile = vault.addFile(
			'Meta/skills/my-skill/SKILL.md',
			'---\nname: my-skill\ndescription: d\n---\nbody',
		);
		attachToFolder(root, sub);
		attachToFolder(sub, skillFile);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();
		expect(registry.all().map((s) => s.name)).toEqual(['my-skill']);
	});

	it('visibleOnThisPlatform filters mobile-hidden skills on mobile', async () => {
		const folder = vault.addFolder('Meta/skills');
		const desktop = vault.addFile(
			'Meta/skills/desk.md',
			'---\nname: desk\ndescription: d\nmobile: false\n---\nbody',
		);
		const mobile = vault.addFile(
			'Meta/skills/mob.md',
			'---\nname: mob\ndescription: m\n---\nbody',
		);
		attachToFolder(folder, desktop);
		attachToFolder(folder, mobile);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();

		Platform.isMobile = false;
		expect(registry.visibleOnThisPlatform().map((s) => s.name).sort()).toEqual(['desk', 'mob']);

		Platform.isMobile = true;
		expect(registry.visibleOnThisPlatform().map((s) => s.name)).toEqual(['mob']);
	});

	it('loadable() refuses mobile-hidden skills on mobile (the v0.1.16 fix)', async () => {
		const folder = vault.addFolder('Meta/skills');
		const desktop = vault.addFile(
			'Meta/skills/desk.md',
			'---\nname: desk\ndescription: d\nmobile: false\n---\nbody',
		);
		attachToFolder(folder, desktop);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();

		// getByName still finds it (kept for any future generic lookup), but
		// loadable() — the resolver load_skill uses — refuses on mobile.
		Platform.isMobile = true;
		expect(registry.getByName('desk')?.name).toBe('desk');
		expect(registry.loadable('desk')).toBeNull();

		Platform.isMobile = false;
		expect(registry.loadable('desk')?.name).toBe('desk');
	});

	it('manifestText omits hidden skills on mobile', async () => {
		const folder = vault.addFolder('Meta/skills');
		const desktop = vault.addFile(
			'Meta/skills/desk.md',
			'---\nname: desk\ndescription: d\nmobile: false\n---\nbody',
		);
		const mobile = vault.addFile(
			'Meta/skills/mob.md',
			'---\nname: mob\ndescription: m\n---\nbody',
		);
		attachToFolder(folder, desktop);
		attachToFolder(folder, mobile);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();

		Platform.isMobile = true;
		const text = registry.manifestText();
		expect(text).toContain('mob: m');
		expect(text).not.toContain('desk: d');
	});

	it('manifestText returns "" with no skills', async () => {
		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load(); // folder missing → no skills
		expect(registry.manifestText()).toBe('');
	});

	it('returns no skills when the dir is missing entirely', async () => {
		const registry = new SkillRegistry(app, 'Missing/dir');
		await registry.load();
		expect(registry.all()).toEqual([]);
	});

	it('userInvocableSkills returns only skills with user-invocable: true', async () => {
		const folder = vault.addFolder('Meta/skills');
		const slashable = vault.addFile(
			'Meta/skills/editor.md',
			'---\nname: editor\ndescription: d\nuser-invocable: true\n---\nbody',
		);
		const auto = vault.addFile(
			'Meta/skills/auto.md',
			'---\nname: auto\ndescription: d\n---\nbody',
		);
		attachToFolder(folder, slashable);
		attachToFolder(folder, auto);

		const registry = new SkillRegistry(app, 'Meta/skills');
		await registry.load();
		expect(registry.userInvocableSkills().map((s) => s.name)).toEqual(['editor']);
	});

	it('setDir falls back to the default when given an empty string', async () => {
		const folder = vault.addFolder('Meta/skills');
		const file = vault.addFile('Meta/skills/x.md', '---\nname: x\ndescription: d\n---\nbody');
		attachToFolder(folder, file);

		const registry = new SkillRegistry(app, 'tmp');
		registry.setDir('');
		await registry.load();
		// Loaded from the default 'Meta/skills'.
		expect(registry.all().map((s) => s.name)).toEqual(['x']);
	});
});
