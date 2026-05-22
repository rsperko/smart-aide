import { App, Platform, TFile, TFolder } from 'obsidian';

export interface Skill {
	name: string;
	description: string;
	body: string;
	source: 'desktop' | 'vault';
	path: string;
	mobile: boolean;
}

const VAULT_SKILLS_DIR = 'sys/skills';

/**
 * Skill discovery and lookup.
 *
 * Desktop: reads from ~/.agents/skills/ via Node fs (shared with Pi and Claude Code).
 * Mobile: reads from <vault>/sys/skills/ only (Node APIs aren't available).
 *
 * Each skill is either:
 *   - a single Markdown file named <name>.md whose frontmatter has `name` + `description`
 *   - a directory containing SKILL.md (preferred for skills with assets)
 */
export class SkillRegistry {
	private skills: Skill[] = [];

	constructor(private app: App) {}

	async load(): Promise<void> {
		const fromDesktop = Platform.isDesktopApp ? await this.loadDesktop() : [];
		const fromVault = await this.loadVault();
		// Dedupe by name — desktop wins (it's the source of truth).
		const byName = new Map<string, Skill>();
		for (const s of fromVault) byName.set(s.name, s);
		for (const s of fromDesktop) byName.set(s.name, s);
		this.skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	all(): Skill[] {
		return this.skills;
	}

	visibleOnThisPlatform(): Skill[] {
		if (!Platform.isMobile) return this.skills;
		return this.skills.filter((s) => s.mobile);
	}

	getByName(name: string): Skill | null {
		const lower = name.toLowerCase();
		return this.skills.find((s) => s.name.toLowerCase() === lower) ?? null;
	}

	/** One-line manifest of skill descriptions for the system prompt. */
	manifestText(): string {
		const visible = this.visibleOnThisPlatform();
		if (visible.length === 0) return '';
		const lines = visible.map((s) => `- ${s.name}: ${s.description}`);
		return [
			'Available skills (call load_skill(name) to load any one into context):',
			...lines,
		].join('\n');
	}

	// -------- Desktop discovery (Node fs) --------

	private async loadDesktop(): Promise<Skill[]> {
		try {
			// require is lazy so mobile bundles don't break — esbuild treats fs/os/path as externals.
			const fs = require('fs/promises');
			const os = require('os');
			const path = require('path');
			const skillsDir = path.join(os.homedir(), '.agents', 'skills');
			const exists = await fs.stat(skillsDir).catch(() => null);
			if (!exists) return [];
			const out: Skill[] = [];
			const entries = await fs.readdir(skillsDir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(skillsDir, entry.name);
				if (entry.isDirectory()) {
					const skillMd = path.join(full, 'SKILL.md');
					const exists = await fs.stat(skillMd).catch(() => null);
					if (!exists) continue;
					const content = await fs.readFile(skillMd, 'utf8');
					const skill = parseSkillContent(content, full, 'desktop');
					if (skill) out.push(skill);
				} else if (entry.isFile() && entry.name.endsWith('.md')) {
					const content = await fs.readFile(full, 'utf8');
					const skill = parseSkillContent(content, full, 'desktop');
					if (skill) out.push(skill);
				} else if (entry.isSymbolicLink()) {
					// Follow symlinks (the user's setup uses dotfile symlinks)
					try {
						const real = await fs.realpath(full);
						const realStat = await fs.stat(real);
						if (realStat.isDirectory()) {
							const skillMd = path.join(real, 'SKILL.md');
							const exists = await fs.stat(skillMd).catch(() => null);
							if (!exists) continue;
							const content = await fs.readFile(skillMd, 'utf8');
							const skill = parseSkillContent(content, real, 'desktop');
							if (skill) out.push(skill);
						}
					} catch {
						// Broken symlink — skip
					}
				}
			}
			return out;
		} catch (e) {
			console.warn('smart-aide: desktop skill discovery failed', e);
			return [];
		}
	}

	// -------- Mobile (and shared) vault discovery --------

	private async loadVault(): Promise<Skill[]> {
		const folder = this.app.vault.getAbstractFileByPath(VAULT_SKILLS_DIR);
		if (!(folder instanceof TFolder)) return [];
		const out: Skill[] = [];
		const walk = async (f: TFolder): Promise<void> => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === 'md') {
					// Either <name>.md or SKILL.md inside a directory
					const isSkillMd = child.basename === 'SKILL';
					const content = await this.app.vault.cachedRead(child);
					const skill = parseSkillContent(content, child.path, 'vault');
					if (skill) {
						// If SKILL.md inside a directory, use the directory name as fallback
						if (isSkillMd && child.parent) skill.name = skill.name || child.parent.name;
						out.push(skill);
					}
				} else if (child instanceof TFolder) {
					await walk(child);
				}
			}
		};
		await walk(folder);
		return out;
	}
}

/** Minimal frontmatter parser — `name` and `description` only. */
function parseSkillContent(content: string, path: string, source: 'desktop' | 'vault'): Skill | null {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) return null;
	const fmText = fmMatch[1];
	const body = fmMatch[2].trim();
	const name = scalarField(fmText, 'name');
	const description = scalarField(fmText, 'description');
	if (!name || !description) return null;
	const mobile = scalarField(fmText, 'mobile') !== 'false';
	return { name, description, body, source, path, mobile };
}

function scalarField(yaml: string, key: string): string {
	// Supports `key: value`, `key: 'value'`, `key: "value"`. Single-line only.
	const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'mi');
	const match = yaml.match(re);
	if (!match) return '';
	let value = match[1].trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}
	return value;
}
