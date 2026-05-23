import { App, Platform, TFile, TFolder, normalizePath } from 'obsidian';

export interface Skill {
	name: string;
	description: string;
	body: string;
	path: string;
	mobile: boolean;
}

/**
 * Skill discovery and lookup.
 *
 * Skills live in a single vault-relative directory (default `sys/skills/`,
 * configurable in settings). Both desktop and mobile read from the same place
 * — no Node-fs fallback, no platform divergence. Users who want to share their
 * skills with Pi or Claude Code can symlink the vault directory to
 * `~/.agents/skills/` themselves; the plugin doesn't reach outside the vault.
 *
 * Each skill is either:
 *   - a single Markdown file (e.g. `meeting-notes.md`) whose frontmatter has `name` + `description`
 *   - a directory containing `SKILL.md` (preferred when the skill has assets, references, scripts)
 */
export class SkillRegistry {
	private skills: Skill[] = [];

	constructor(private app: App, private dir: string = 'sys/skills') {}

	setDir(dir: string): void {
		this.dir = normalizePath(dir || 'sys/skills');
	}

	async load(): Promise<void> {
		const dir = normalizePath(this.dir || 'sys/skills');
		const folder = this.app.vault.getAbstractFileByPath(dir);
		if (!(folder instanceof TFolder)) {
			this.skills = [];
			return;
		}
		const out: Skill[] = [];
		const walk = async (f: TFolder): Promise<void> => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === 'md') {
					const isSkillMd = child.basename === 'SKILL';
					const content = await this.app.vault.cachedRead(child);
					const skill = parseSkillContent(content, child.path);
					if (skill) {
						if (isSkillMd && child.parent) skill.name = skill.name || child.parent.name;
						out.push(skill);
					}
				} else if (child instanceof TFolder) {
					await walk(child);
				}
			}
		};
		await walk(folder);
		this.skills = out.sort((a, b) => a.name.localeCompare(b.name));
	}

	all(): Skill[] {
		return this.skills;
	}

	visibleOnThisPlatform(): Skill[] {
		// `mobile: false` in frontmatter hides skills that depend on desktop-only
		// scripts or filesystem access. On desktop, all skills are visible.
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
			'Skills available — load any one with load_skill(name) when its description matches the user\'s request:',
			...lines,
		].join('\n');
	}
}

/** Minimal frontmatter parser — `name`, `description`, and the optional `mobile` flag. */
function parseSkillContent(content: string, path: string): Skill | null {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) return null;
	const fmText = fmMatch[1];
	const body = fmMatch[2].trim();
	const name = scalarField(fmText, 'name');
	const description = scalarField(fmText, 'description');
	if (!name || !description) return null;
	const mobile = scalarField(fmText, 'mobile') !== 'false';
	return { name, description, body, path, mobile };
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
