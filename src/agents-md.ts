import { App, TFile, normalizePath } from 'obsidian';

const AGENTS_FILE = 'AGENTS.md';

/**
 * Reads user-maintained AGENTS.md files into the system prompt.
 *
 * AGENTS.md is the cross-tool standard (agents.md, Linux-Foundation-stewarded)
 * for handing an agent project-specific context. Here the "project" is the
 * vault: layout, tag conventions, ongoing initiatives, paths to avoid.
 *
 * Two locations are checked, matching the pattern used by Claude Code, Codex,
 * and the agents.md spec for nested files — outer first, inner second, both
 * concatenated so the closer (plugin-specific) file appears later and wins on
 * any overlap:
 *   1. <vaultRoot>/AGENTS.md — the standard location other tools already read
 *   2. ${metaDir}/AGENTS.md  — plugin-specific augmentation/override
 *
 * Either or both may be absent. If both are present, the body is rendered with
 * per-file headers and a horizontal rule so the model can distinguish sources.
 * If metaDir resolves to the vault root, the file is read once (not duplicated).
 */
export class AgentsMdRegistry {
	private body = '';

	constructor(private app: App, private metaDir: string = 'Meta') {}

	setDir(metaDir: string): void {
		this.metaDir = metaDir;
	}

	async load(): Promise<void> {
		const rootPath = normalizePath(AGENTS_FILE);
		const metaPath = normalizePath(`${this.metaDir || 'Meta'}/${AGENTS_FILE}`);
		const root = await this.readIfPresent(rootPath);
		const meta = rootPath === metaPath ? '' : await this.readIfPresent(metaPath);
		if (root && meta) {
			this.body = `# ${rootPath}\n\n${root}\n\n---\n\n# ${metaPath}\n\n${meta}`;
		} else {
			this.body = root || meta;
		}
	}

	private async readIfPresent(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return '';
		return (await this.app.vault.cachedRead(file)).trim();
	}

	text(): string {
		return this.body;
	}
}
