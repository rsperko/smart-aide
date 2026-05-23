import type { App } from 'obsidian';
import type { ImageBlock } from './types';

const EXT_TO_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	heic: 'image/heic',
	heif: 'image/heif',
};

const MIME_TO_EXT: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/heic': 'heic',
	'image/heif': 'heif',
};

const SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function mimeFromExtension(path: string): string {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return 'application/octet-stream';
	const ext = path.slice(dot + 1).toLowerCase();
	return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export function mimeToExtension(mime: string): string {
	return MIME_TO_EXT[mime] ?? 'bin';
}

/**
 * Whether the given mime is one nearly all hosted vision models accept directly.
 * HEIC/HEIF are intentionally excluded — most cloud APIs reject them, and iPhone
 * users hit this constantly. UI surfaces a clear error rather than passing through
 * and letting the model 400.
 */
export function isSupportedImageMime(mime: string): boolean {
	return SUPPORTED_MIMES.has(mime);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	// btoa works on binary strings; build one in chunks to avoid blowing the
	// argument-length limit on large buffers (each char is one byte).
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const slice = bytes.subarray(i, i + CHUNK);
		binary += String.fromCharCode.apply(null, slice as unknown as number[]);
	}
	return btoa(binary);
}

export function dataUrlFor(mime: string, base64: string): string {
	return `data:${mime};base64,${base64}`;
}

/**
 * Choose a filename for a freshly attached image. Honors a user-provided name
 * when present; otherwise mints a timestamped name keyed off the mime.
 */
/**
 * Save bytes into Obsidian's configured attachment folder and return an
 * ImageBlock referencing the resolved vault path. The block is what gets
 * persisted in the session JSONL; bytes are read back on send.
 */
export async function attachImageToVault(
	app: App,
	bytes: ArrayBuffer,
	filename: string,
	mime: string,
): Promise<ImageBlock> {
	if (!isSupportedImageMime(mime)) {
		throw new Error(`${mime} is not supported. Use JPEG, PNG, GIF, or WebP.`);
	}
	const name = suggestedImageName(filename, mime);
	const path = await app.fileManager.getAvailablePathForAttachment(name);
	await app.vault.createBinary(path, bytes);
	return { type: 'image', path, mime };
}

export function suggestedImageName(name: string, mime: string): string {
	if (name && name.trim().length > 0) return name;
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp =
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	return `pasted-${stamp}.${mimeToExtension(mime)}`;
}
