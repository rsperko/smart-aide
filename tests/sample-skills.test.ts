import { beforeEach, describe, expect, it } from 'vitest';
import { TFile, Vault } from 'obsidian';
import {
	SAMPLE_SKILLS,
	installSample,
	readSampleStatus,
	type SampleSkill,
} from '../src/sample-skills';
import { parseSkillContent } from '../src/skills';

class InMemoryVault {
	files = new Map<string, string>();
	folders = new Set<string>();

	getFileByPath(path: string): TFile | null {
		if (!this.files.has(path)) return null;
		const name = path.split('/').pop() ?? '';
		const f = Object.assign(new TFile(), { path, name, extension: 'md', basename: name.replace(/\.md$/, '') });
		f.stat = { mtime: 0, ctime: 0, size: this.files.get(path)!.length };
		return f;
	}
	async cachedRead(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? '';
	}
	async read(file: TFile): Promise<string> {
		return this.cachedRead(file);
	}
	async create(path: string, content: string): Promise<TFile> {
		this.files.set(path, content);
		return this.getFileByPath(path)!;
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
	async modify(file: TFile, content: string): Promise<void> {
		this.files.set(file.path, content);
	}
	adapter = {
		exists: async (p: string) => this.files.has(p) || this.folders.has(p),
	};
}

function makeSkill(overrides: Partial<SampleSkill> = {}): SampleSkill {
	return {
		name: 'test-skill',
		shortDescription: 'A test skill',
		recommendedModel: 'Test Model',
		body: '---\nname: test-skill\ndescription: test\n---\n\nbody\n',
		...overrides,
	};
}

describe('SAMPLE_SKILLS catalog', () => {
	it('exports exactly the six shipped skills, in display order', () => {
		expect(SAMPLE_SKILLS.map((s) => s.name)).toEqual([
			'handwriting-ocr',
			'meeting-notes',
			'daily-note',
			'process-inbox',
			'moc-builder',
			'weekly-review',
		]);
	});

	it('every sample has the required fields populated', () => {
		for (const s of SAMPLE_SKILLS) {
			expect(s.name).toMatch(/^[a-z][a-z0-9-]+$/);
			expect(s.shortDescription.length).toBeGreaterThan(0);
			expect(s.recommendedModel.length).toBeGreaterThan(0);
			expect(s.body).toContain('---');
			expect(s.body).toContain(`name: ${s.name}`);
			expect(s.body).toContain('description:');
		}
	});

	it('body frontmatter is parseable by the in-vault SkillRegistry shape (---\\n…\\n---)', () => {
		for (const s of SAMPLE_SKILLS) {
			expect(s.body).toMatch(/^---\n/);
			expect(s.body).toMatch(/\nname:\s*[a-z][a-z0-9-]+/);
			expect(s.body).toMatch(/\n---\n/);
		}
	});

	it('every sample round-trips cleanly through parseSkillContent — no quote-escape artifacts', () => {
		for (const s of SAMPLE_SKILLS) {
			const parsed = parseSkillContent(s.body, `Meta/skills/${s.name}.md`);
			expect(parsed).not.toBeNull();
			expect(parsed!.name).toBe(s.name);
			// The description shown to the model must not contain raw quote escapes.
			expect(parsed!.description).not.toMatch(/\\"/);
			expect(parsed!.description).not.toMatch(/''/);
			expect(parsed!.description.length).toBeGreaterThan(20);
		}
	});
});

describe('readSampleStatus', () => {
	let vault: InMemoryVault;
	const skill = makeSkill();

	beforeEach(() => {
		vault = new InMemoryVault();
	});

	it('returns not-installed when the file is missing', async () => {
		const got = await readSampleStatus(vault as unknown as Vault, 'Meta/skills', skill);
		expect(got).toEqual({ state: 'not-installed', path: 'Meta/skills/test-skill.md' });
	});

	it('returns installed-current when bytes match the bundle', async () => {
		await vault.create('Meta/skills/test-skill.md', skill.body);
		const got = await readSampleStatus(vault as unknown as Vault, 'Meta/skills', skill);
		expect(got.state).toBe('installed-current');
	});

	it('returns installed-modified when on-disk bytes drift from the bundle', async () => {
		await vault.create('Meta/skills/test-skill.md', skill.body + '\n# my customization\n');
		const got = await readSampleStatus(vault as unknown as Vault, 'Meta/skills', skill);
		expect(got.state).toBe('installed-modified');
	});
});

describe('installSample', () => {
	let vault: InMemoryVault;
	const skill = makeSkill();

	beforeEach(() => {
		vault = new InMemoryVault();
	});

	it('creates the skills folder + file when neither exists', async () => {
		const res = await installSample(vault as unknown as Vault, 'Meta/skills', skill);
		expect(res).toEqual({ status: 'created', path: 'Meta/skills/test-skill.md' });
		expect(vault.folders.has('Meta/skills')).toBe(true);
		expect(vault.files.get('Meta/skills/test-skill.md')).toBe(skill.body);
	});

	it('is a no-op when the on-disk copy already matches the bundle', async () => {
		await vault.create('Meta/skills/test-skill.md', skill.body);
		const res = await installSample(vault as unknown as Vault, 'Meta/skills', skill);
		expect(res.status).toBe('unchanged');
		expect(vault.files.get('Meta/skills/test-skill.md')).toBe(skill.body);
	});

	it('refuses to overwrite a customized file when overwrite is not set', async () => {
		const custom = skill.body + '\n# customized\n';
		await vault.create('Meta/skills/test-skill.md', custom);
		const res = await installSample(vault as unknown as Vault, 'Meta/skills', skill);
		expect(res.status).toBe('skipped-modified');
		expect(vault.files.get('Meta/skills/test-skill.md')).toBe(custom);
		expect(vault.files.has('Meta/skills/test-skill.md.bak')).toBe(false);
	});

	it('overwrites a customized file with overwrite=true after saving a .bak backup', async () => {
		const custom = skill.body + '\n# customized\n';
		await vault.create('Meta/skills/test-skill.md', custom);
		const res = await installSample(vault as unknown as Vault, 'Meta/skills', skill, { overwrite: true });
		expect(res.status).toBe('overwritten');
		if (res.status === 'overwritten') {
			expect(res.backupPath).toBe('Meta/skills/test-skill.md.bak');
		}
		expect(vault.files.get('Meta/skills/test-skill.md')).toBe(skill.body);
		expect(vault.files.get('Meta/skills/test-skill.md.bak')).toBe(custom);
	});

	it('updates an existing .bak when re-installing twice over a customized file', async () => {
		const v1 = skill.body + '\n# version 1\n';
		await vault.create('Meta/skills/test-skill.md', v1);
		await installSample(vault as unknown as Vault, 'Meta/skills', skill, { overwrite: true });
		expect(vault.files.get('Meta/skills/test-skill.md.bak')).toBe(v1);

		// Simulate the user editing the bundled copy and a second re-install.
		const v2 = skill.body + '\n# version 2\n';
		await vault.modify(vault.getFileByPath('Meta/skills/test-skill.md')!, v2);
		await installSample(vault as unknown as Vault, 'Meta/skills', skill, { overwrite: true });
		expect(vault.files.get('Meta/skills/test-skill.md.bak')).toBe(v2);
		expect(vault.files.get('Meta/skills/test-skill.md')).toBe(skill.body);
	});
});
