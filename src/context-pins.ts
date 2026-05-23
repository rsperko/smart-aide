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

	/**
	 * Per-file cap mirrors read_note's auto-truncation so a single huge active
	 * note can't blow the context window or multiply spend across tool turns.
	 */
	static MAX_BYTES_PER_FILE = 25_000;

	/** Rough token estimate (chars ÷ 4) for the truncated contribution. 0 if missing. */
	async estimateTokens(path: string): Promise<number> {
		const status = await this.statusOf(path);
		return status ? status.tokens : 0;
	}

	/**
	 * Returns the contribution of a pin: tokens/bytes actually sent to the model,
	 * and the file's total bytes (for surfacing how much was clipped). Returns
	 * null when the file is missing.
	 */
	async statusOf(path: string): Promise<{ tokens: number; sentBytes: number; totalBytes: number; truncated: boolean } | null> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const content = await this.app.vault.cachedRead(file);
		const truncated = content.length > PinnedContext.MAX_BYTES_PER_FILE;
		const sentBytes = truncated ? PinnedContext.MAX_BYTES_PER_FILE : content.length;
		return { tokens: Math.ceil(sentBytes / 4), sentBytes, totalBytes: content.length, truncated };
	}

	/**
	 * Build a preamble that prepends to the latest user message. Each turn re-
	 * reads the file so edits show up immediately. Returns empty string if no
	 * files are pinned (or all pinned paths are missing). Each file is capped at
	 * MAX_BYTES_PER_FILE with an explicit marker so the model knows there's more.
	 */
	async buildPreamble(): Promise<string> {
		if (this.paths.length === 0) return '';
		const sections: string[] = [];
		for (const path of this.paths) {
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const full = await this.app.vault.cachedRead(file);
			const trimmed = full.trim();
			if (trimmed.length <= PinnedContext.MAX_BYTES_PER_FILE) {
				sections.push(`File: ${path}\n\n${trimmed}`);
			} else {
				const head = trimmed.slice(0, PinnedContext.MAX_BYTES_PER_FILE);
				const marker = `\n\n…(truncated — pinned files are capped to ~${Math.round(
					PinnedContext.MAX_BYTES_PER_FILE / 1000,
				)}KB; full file is ${full.length} bytes; use read_note for more)`;
				sections.push(`File: ${path}\n\n${head}${marker}`);
			}
		}
		if (sections.length === 0) return '';
		return [
			"[The user has the following notes open in their Obsidian editor. Reference them directly when relevant; you don't need to call read_note to access these.]",
			'',
			...sections.map((s, i) => (i === 0 ? s : `\n---\n\n${s}`)),
		].join('\n');
	}
}
