import { App, TFile } from 'obsidian';
import type { WebExtract, YouTubeExtract } from './url-extract';

interface FilePinCache {
	mtime: number;
	size: number;
	status: PinStatus;
	section: string;
}

export interface PinStatus {
	tokens: number;
	sentBytes: number;
	totalBytes: number;
	truncated: boolean;
}

export interface FilePin {
	type: 'file';
	/** Identifier for has/remove/statusOf. For file pins, equals the vault path. */
	key: string;
	path: string;
}

export interface UrlPin {
	type: 'url';
	key: string;
	url: string;
	title: string;
	content: string;
	byline?: string;
	fetchedAt: number;
}

export interface YouTubePin {
	type: 'youtube';
	key: string;
	url: string;
	videoId: string;
	title: string;
	channel: string;
	transcript: string;
	fetchedAt: number;
}

export type Pin = FilePin | UrlPin | YouTubePin;

/**
 * Per-chat list of items pinned into the model's context. Three variants:
 *   - file: a `.md` path in the vault. Content is re-read on every turn so
 *     edits in Obsidian show up immediately (cached by mtime+size).
 *   - url: an arbitrary web page. Content is fetched + extracted once at pin
 *     time and reused for the life of the chat. User unpins + re-adds to
 *     refresh.
 *   - youtube: a video URL with caption track. Same caching shape as url.
 *
 * Pins are in-memory only — not persisted across plugin reloads. Closing and
 * reopening a chat clears them. (Persistence is a separate feature; see
 * agent_notes/features/projects.md for the right place to put cross-chat pin
 * reuse.)
 */
export class PinnedContext {
	private pins: Pin[] = [];
	// File-pin cache: keyed by path, invalidated when stat (mtime+size) changes.
	private fileCache = new Map<string, FilePinCache>();

	constructor(private app: App) {}

	/** Cap mirroring read_note's auto-truncation. Applies to file content + URL
	 *  / YouTube extract length. */
	static MAX_BYTES_PER_FILE = 25_000;

	list(): Pin[] {
		return [...this.pins];
	}

	has(key: string): boolean {
		return this.pins.some((p) => p.key === key);
	}

	/**
	 * Back-compat: `add(path)` keeps working as an alias for `addFile(path)`.
	 * New callers should use `addFile` for clarity.
	 */
	add(path: string): void {
		this.addFile(path);
	}

	addFile(path: string): void {
		if (this.has(path)) return;
		this.pins.push({ type: 'file', key: path, path });
	}

	addUrl(extract: WebExtract): void {
		if (this.has(extract.url)) return;
		this.pins.push({
			type: 'url',
			key: extract.url,
			url: extract.url,
			title: extract.title,
			content: extract.content,
			byline: extract.byline,
			fetchedAt: extract.fetchedAt,
		});
	}

	addYouTube(extract: YouTubeExtract): void {
		if (this.has(extract.url)) return;
		this.pins.push({
			type: 'youtube',
			key: extract.url,
			url: extract.url,
			videoId: extract.videoId,
			title: extract.title,
			channel: extract.channel,
			transcript: extract.transcript,
			fetchedAt: extract.fetchedAt,
		});
	}

	remove(key: string): void {
		this.pins = this.pins.filter((p) => p.key !== key);
		this.fileCache.delete(key);
	}

	clear(): void {
		this.pins = [];
		this.fileCache.clear();
	}

	/**
	 * Token contribution of a single pin: tokens/bytes sent + the underlying
	 * source size (so the UI can show "truncated, full file is X bytes").
	 * Returns null when the pin's underlying source has gone missing (file pin
	 * pointing at a deleted note).
	 */
	async statusOf(key: string): Promise<PinStatus | null> {
		const pin = this.pins.find((p) => p.key === key);
		if (!pin) return null;
		if (pin.type === 'file') {
			const file = this.app.vault.getFileByPath(pin.path);
			if (!(file instanceof TFile)) {
				this.fileCache.delete(pin.path);
				return null;
			}
			const entry = await this.fileEntryFor(file);
			return entry.status;
		}
		const body = pin.type === 'url' ? pin.content : pin.transcript;
		return urlPinStatus(body);
	}

	async estimateTokens(key: string): Promise<number> {
		const status = await this.statusOf(key);
		return status ? status.tokens : 0;
	}

	/**
	 * Concatenate every pin's content into a single preamble prepended to the
	 * latest user message. Each pin contributes one section; file pins re-read
	 * on stat change so edits show up immediately. Skips pins whose underlying
	 * source disappeared; returns "" when nothing usable is pinned.
	 */
	async buildPreamble(): Promise<string> {
		if (this.pins.length === 0) return '';
		const sections: string[] = [];
		for (const pin of this.pins) {
			const section = await this.sectionFor(pin);
			if (section) sections.push(section);
		}
		if (sections.length === 0) return '';
		return [
			"[The user has pinned the following items as context for this chat. Reference them directly when relevant; you don't need to call read_note for the file pins.]",
			'',
			...sections.map((s, i) => (i === 0 ? s : `\n---\n\n${s}`)),
		].join('\n');
	}

	private async sectionFor(pin: Pin): Promise<string | null> {
		if (pin.type === 'file') {
			const file = this.app.vault.getFileByPath(pin.path);
			if (!(file instanceof TFile)) {
				this.fileCache.delete(pin.path);
				return null;
			}
			return (await this.fileEntryFor(file)).section;
		}
		if (pin.type === 'url') {
			const body = pin.content;
			const heading = pin.byline
				? `Web page: ${pin.title}\nSource: ${pin.url}\nByline: ${pin.byline}`
				: `Web page: ${pin.title}\nSource: ${pin.url}`;
			return formatUrlSection(heading, body);
		}
		// youtube
		const heading = `YouTube transcript: ${pin.title}${pin.channel ? `\nChannel: ${pin.channel}` : ''}\nSource: ${pin.url}`;
		return formatUrlSection(heading, pin.transcript);
	}

	private async fileEntryFor(file: TFile): Promise<FilePinCache> {
		const cached = this.fileCache.get(file.path);
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

		const entry: FilePinCache = {
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
		this.fileCache.set(file.path, entry);
		return entry;
	}
}

function urlPinStatus(body: string): PinStatus {
	const total = body.length;
	const sent = Math.min(total, PinnedContext.MAX_BYTES_PER_FILE);
	return {
		tokens: Math.ceil(sent / 4),
		sentBytes: sent,
		totalBytes: total,
		truncated: total > PinnedContext.MAX_BYTES_PER_FILE,
	};
}

function formatUrlSection(heading: string, body: string): string {
	if (body.length <= PinnedContext.MAX_BYTES_PER_FILE) return `${heading}\n\n${body}`;
	return `${heading}\n\n${body.slice(0, PinnedContext.MAX_BYTES_PER_FILE)}\n\n…(truncated — pinned web content is capped to ~${Math.round(
		PinnedContext.MAX_BYTES_PER_FILE / 1000,
	)}KB; full source is ${body.length} bytes; visit the URL for the rest)`;
}
