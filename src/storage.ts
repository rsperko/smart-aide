import { TFile, TFolder, Vault, normalizePath } from 'obsidian';
import { messageText } from './view-helpers';
import {
	AgentMessage,
	CustomEntry,
	CustomMessageEntry,
	Entry,
	MessageEntry,
	ModelChangeEntry,
	SessionHeader,
	SessionInfoEntry,
	ToolCallBlock,
	ToolResultBlock,
} from './types';

const DEFAULT_CHATS_DIR = 'Meta/chats';

function uuid(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function shortId(): string {
	const buf = new Uint8Array(4);
	crypto.getRandomValues(buf);
	return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function dateStamp(d = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export interface ChatSession {
	path: string;
	header: SessionHeader;
	entries: Entry[];
	leafId: string | null;
	title: string;
}

export class ChatStorage {
	constructor(private vault: Vault, private dir: string = DEFAULT_CHATS_DIR) {}

	setDir(dir: string): void {
		this.dir = normalizePath(dir || DEFAULT_CHATS_DIR);
	}

	async ensureDir(): Promise<void> {
		if (!(await this.vault.adapter.exists(this.dir))) {
			await this.vault.createFolder(this.dir);
		}
	}

	async createChat(): Promise<ChatSession> {
		await this.ensureDir();
		const id = uuid();
		const path = normalizePath(`${this.dir}/${dateStamp()}_${id}.jsonl`);
		const header: SessionHeader = {
			type: 'session',
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd: this.vault.getName(),
		};
		// File creation is deferred to the first appendEntry. Otherwise every "New chat"
		// tap creates a file even if the user never sends a message, polluting the picker.
		return { path, header, entries: [], leafId: null, title: 'New chat' };
	}

	async loadChat(path: string): Promise<ChatSession> {
		const file = this.vault.getFileByPath(path);
		if (!file) throw new Error(`not a file: ${path}`);
		const raw = await this.vault.cachedRead(file);
		const lines = raw.split('\n').filter((l) => l.trim());
		if (lines.length === 0) throw new Error(`empty chat file: ${path}`);
		const header = JSON.parse(lines[0]) as SessionHeader;
		const entries = lines.slice(1).map((l) => JSON.parse(l) as Entry);

		const leafId = computeLeaf(entries);
		const title = findTitle(entries) ?? deriveTitleFromMessages(entries) ?? 'New chat';

		return { path, header, entries, leafId, title };
	}

	async deleteChat(path: string): Promise<void> {
		const file = this.vault.getFileByPath(path);
		if (file) await this.vault.delete(file);
	}

	async appendEntry(session: ChatSession, entry: Entry): Promise<void> {
		const file = this.vault.getFileByPath(session.path);
		if (!file) {
			// First persisted entry — create the session file with header + any entries
			// queued in memory (e.g., the initial model_change) + this entry, all at once.
			const lines = [JSON.stringify(session.header)];
			for (const queued of session.entries) lines.push(JSON.stringify(queued));
			lines.push(JSON.stringify(entry));
			await this.vault.create(session.path, lines.join('\n') + '\n');
		} else {
			await this.vault.append(file, JSON.stringify(entry) + '\n');
		}
		session.entries.push(entry);
		session.leafId = entry.id;
	}

	/**
	 * Remove session files that contain no message entries (header + maybe a
	 * model_change but nothing the user actually said). Runs on plugin load to
	 * sweep up any pollution from older builds that persisted empty chats.
	 */
	async cleanupEmptyChats(): Promise<number> {
		const folder = this.vault.getAbstractFileByPath(this.dir);
		if (!(folder instanceof TFolder)) return 0;
		let removed = 0;
		for (const child of [...folder.children]) {
			if (!(child instanceof TFile) || child.extension !== 'jsonl') continue;
			try {
				const content = await this.vault.cachedRead(child);
				const lines = content.split('\n').filter((l) => l.trim());
				let hasMessage = false;
				for (let i = 1; i < lines.length; i++) {
					try {
						const e = JSON.parse(lines[i]) as Entry;
						if (e.type === 'message') {
							hasMessage = true;
							break;
						}
					} catch {
						// malformed line — skip
					}
				}
				if (!hasMessage) {
					await this.vault.delete(child);
					removed++;
				}
			} catch {
				// skip files we can't read
			}
		}
		return removed;
	}

	makeMessageEntry(message: AgentMessage, parentId: string | null): MessageEntry {
		return {
			type: 'message',
			id: shortId(),
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
	}

	makeModelChangeEntry(provider: string, modelId: string, parentId: string | null): ModelChangeEntry {
		return {
			type: 'model_change',
			id: shortId(),
			parentId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
	}

	makeTitleEntry(name: string, parentId: string | null): SessionInfoEntry {
		return {
			type: 'session_info',
			id: shortId(),
			parentId,
			timestamp: new Date().toISOString(),
			name,
		};
	}

	makeCustomEntry(customType: string, data: unknown, parentId: string | null): CustomEntry {
		return {
			type: 'custom',
			id: shortId(),
			parentId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		};
	}

	makeCustomMessageEntry(
		customType: string,
		content: string,
		display: string | undefined,
		parentId: string | null,
	): CustomMessageEntry {
		return {
			type: 'custom_message',
			id: shortId(),
			parentId,
			timestamp: new Date().toISOString(),
			customType,
			content,
			...(display ? { display } : {}),
		};
	}

	async listChats(): Promise<{ path: string; title: string; preview: string; mtime: number }[]> {
		await this.ensureDir();
		const folder = this.vault.getAbstractFileByPath(this.dir);
		if (!(folder instanceof TFolder)) return [];
		const out: { path: string; title: string; preview: string; mtime: number }[] = [];
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'jsonl') continue;
			try {
				const session = await this.loadChat(child.path);
				const preview = firstUserPreview(session.entries);
				out.push({ path: child.path, title: session.title, preview, mtime: child.stat.mtime });
			} catch {
				out.push({ path: child.path, title: child.basename, preview: '', mtime: child.stat.mtime });
			}
		}
		out.sort((a, b) => b.mtime - a.mtime);
		return out;
	}

	/**
	 * Walk from leaf to root. Returns entries in chronological order (root first).
	 */
	contextChain(session: ChatSession): Entry[] {
		if (!session.leafId) return [];
		const byId = new Map(session.entries.map((e) => [e.id, e]));
		const chain: Entry[] = [];
		let current: Entry | undefined = byId.get(session.leafId);
		while (current) {
			chain.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return chain;
	}

	/**
	 * Resolve an image attachment's bytes from the vault. Used by the provider
	 * layer to inline images into the wire format. Returns null when the file
	 * has been removed — the provider then substitutes a text note so the model
	 * sees that an image was referenced.
	 */
	async resolveImageBytes(path: string): Promise<ArrayBuffer | null> {
		const file = this.vault.getFileByPath(path);
		if (!file) return null;
		return this.vault.readBinary(file);
	}
}

export function computeLeaf(entries: Entry[]): string | null {
	if (entries.length === 0) return null;
	const hasChild = new Set<string>();
	for (const e of entries) if (e.parentId) hasChild.add(e.parentId);
	// Leaf candidates = entries without children. Among them, pick the latest by timestamp.
	const leaves = entries.filter((e) => !hasChild.has(e.id));
	if (leaves.length === 0) return entries[entries.length - 1].id;
	leaves.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
	return leaves[0].id;
}

export function findTitle(entries: Entry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === 'session_info' && e.name) return e.name;
	}
	return null;
}

export function firstUserPreview(entries: Entry[]): string {
	for (const e of entries) {
		if (e.type !== 'message' || e.message.role !== 'user') continue;
		const flat = messageText(e.message, ' ').replace(/\s+/g, ' ').trim();
		return flat.length > 80 ? flat.slice(0, 77) + '…' : flat;
	}
	return '';
}

export function deriveTitleFromMessages(entries: Entry[]): string | null {
	for (const e of entries) {
		if (e.type !== 'message' || e.message.role !== 'user') continue;
		const first = messageText(e.message).trim().split('\n')[0];
		return first.length > 60 ? first.slice(0, 57) + '…' : first || null;
	}
	return null;
}

export type { ToolCallBlock, ToolResultBlock };
