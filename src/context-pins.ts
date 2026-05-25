import { App, TFile } from 'obsidian';

interface PinCacheEntry {
	mtime: number;
	size: number;
	status: { tokens: number; sentBytes: number; totalBytes: number; truncated: boolean };
	section: string;
}

/**
 * Per-chat list of files pinned into the model's context. The model sees their
 * content prepended to each user turn so it can reference them without calling
 * read_note. Pins are in-memory only — not persisted across plugin reloads.
 */
export class PinnedContext {
	private paths: string[] = [];
	// Keyed by path; entries are invalidated when stat (mtime+size) changes,
	// which catches every edit Obsidian writes. Avoids re-trimming/slicing the
	// full file content on every refreshTokenChip + every assistant-loop iteration.
	private cache = new Map<string, PinCacheEntry>();

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
		this.cache.delete(path);
	}

	clear(): void {
		this.paths = [];
		this.cache.clear();
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
		if (!(file instanceof TFile)) {
			this.cache.delete(path);
			return null;
		}
		const entry = await this.entryFor(file);
		return entry.status;
	}

	/**
	 * Build a preamble that prepends to the latest user message. Each turn re-
	 * reads the file when stat changed so edits show up immediately. Returns
	 * empty string if no files are pinned (or all pinned paths are missing).
	 * Each file is capped at MAX_BYTES_PER_FILE with an explicit marker so the
	 * model knows there's more.
	 */
	async buildPreamble(): Promise<string> {
		if (this.paths.length === 0) return '';
		const sections: string[] = [];
		for (const path of this.paths) {
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) {
				this.cache.delete(path);
				continue;
			}
			const entry = await this.entryFor(file);
			sections.push(entry.section);
		}
		if (sections.length === 0) return '';
		return [
			"[The user has the following notes open in their Obsidian editor. Reference them directly when relevant; you don't need to call read_note to access these.]",
			'',
			...sections.map((s, i) => (i === 0 ? s : `\n---\n\n${s}`)),
		].join('\n');
	}

	private async entryFor(file: TFile): Promise<PinCacheEntry> {
		const cached = this.cache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
			return cached;
		}
		const full = await this.app.vault.cachedRead(file);
		const truncatedRaw = full.length > PinnedContext.MAX_BYTES_PER_FILE;
		const sentBytes = truncatedRaw ? PinnedContext.MAX_BYTES_PER_FILE : full.length;

		const trimmed = full.trim();
		const section = trimmed.length > PinnedContext.MAX_BYTES_PER_FILE
			? `File: ${file.path}\n\n${trimmed.slice(0, PinnedContext.MAX_BYTES_PER_FILE)}\n\n…(truncated — pinned files are capped to ~${Math.round(
					PinnedContext.MAX_BYTES_PER_FILE / 1000,
				)}KB; full file is ${full.length} bytes; use read_note for more)`
			: `File: ${file.path}\n\n${trimmed}`;

		const entry: PinCacheEntry = {
			mtime: file.stat.mtime,
			size: file.stat.size,
			status: {
				tokens: Math.ceil(sentBytes / 4),
				sentBytes,
				totalBytes: full.length,
				truncated: truncatedRaw,
			},
			section,
		};
		this.cache.set(file.path, entry);
		return entry;
	}
}
