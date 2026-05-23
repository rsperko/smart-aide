import { App, TFile } from 'obsidian';

/**
 * Per-chat list of files pinned into the model's context. The model sees their
 * content prepended to each user turn so it can reference them without calling
 * read_note. Pins are in-memory only — not persisted across plugin reloads.
 */
export class PinnedContext {
	private paths: string[] = [];

	constructor(private app: App) {}

	list(): string[] {
		return [...this.paths];
	}

	has(path: string): boolean {
		return this.paths.includes(path);
	}

	add(path: string): void {
		if (!this.paths.includes(path)) this.paths.push(path);
	}

	remove(path: string): void {
		this.paths = this.paths.filter((p) => p !== path);
	}

	clear(): void {
		this.paths = [];
	}

	/** Rough token estimate (chars ÷ 4) for a single pinned file. 0 if missing. */
	async estimateTokens(path: string): Promise<number> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return 0;
		const content = await this.app.vault.cachedRead(file);
		return Math.ceil(content.length / 4);
	}

	/**
	 * Build a preamble that prepends to the latest user message. Each turn re-
	 * reads the file so edits show up immediately. Returns empty string if no
	 * files are pinned (or all pinned paths are missing).
	 */
	async buildPreamble(): Promise<string> {
		if (this.paths.length === 0) return '';
		const sections: string[] = [];
		for (const path of this.paths) {
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const content = await this.app.vault.cachedRead(file);
			sections.push(`File: ${path}\n\n${content.trim()}`);
		}
		if (sections.length === 0) return '';
		return [
			"[The user has the following notes open in their Obsidian editor. Reference them directly when relevant; you don't need to call read_note to access these.]",
			'',
			...sections.map((s, i) => (i === 0 ? s : `\n---\n\n${s}`)),
		].join('\n');
	}
}
