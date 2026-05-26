import { App, TFile, normalizePath } from 'obsidian';
import { memoryFileFor } from './settings';

/**
 * Reads the model-curated memory file into the system prompt.
 *
 * Counterpart to AgentsMdRegistry: AGENTS.md is user-authored, the memory file
 * is model-authored (with approval). Lives at `${metaDir}/Smart Aide/memory.md`
 * so the file tree makes plugin-owned content obvious vs the user's notes.
 *
 * Format is plain markdown with `## Section` headings. Sections are part of a
 * fixed taxonomy (see save_memory in src/tools.ts). The user prunes the file
 * directly in Obsidian — no in-app editor.
 */
export class MemoryRegistry {
	private body = '';

	constructor(private app: App, private metaDir: string = 'Meta') {}

	setDir(metaDir: string): void {
		this.metaDir = metaDir;
	}

	async load(): Promise<void> {
		const path = normalizePath(memoryFileFor(this.metaDir));
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

	path(): string {
		return normalizePath(memoryFileFor(this.metaDir));
	}
}
