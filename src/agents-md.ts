import { App, TFile, normalizePath } from 'obsidian';

const AGENTS_FILE = 'AGENTS.md';

/**
 * Reads a user-maintained `${metaDir}/AGENTS.md` into the system prompt.
 *
 * AGENTS.md is the cross-tool standard (agents.md, Linux-Foundation-stewarded)
 * for handing an agent project-specific context. Here the "project" is the
 * vault: layout, tag conventions, ongoing initiatives, paths to avoid. The file
 * is optional — if absent, `text()` returns '' and the system prompt is
 * unchanged.
 */
export class AgentsMdRegistry {
	private body = '';

	constructor(private app: App, private metaDir: string = 'Meta') {}

	setDir(metaDir: string): void {
		this.metaDir = metaDir;
	}

	async load(): Promise<void> {
		const path = normalizePath(`${this.metaDir || 'Meta'}/${AGENTS_FILE}`);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.body = '';
			return;
		}
		this.body = (await this.app.vault.cachedRead(file)).trim();
	}

	text(): string {
		return this.body;
	}
}
