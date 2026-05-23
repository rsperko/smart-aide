import { describe, expect, it } from 'vitest';
import { App, TFile } from 'obsidian';
import {
	arrayBufferToBase64,
	attachImageToVault,
	dataUrlFor,
	isSupportedImageMime,
	mimeFromExtension,
	mimeToExtension,
	suggestedImageName,
} from '../src/image-helpers';

describe('mimeFromExtension', () => {
	it('maps the common image extensions (case-insensitive)', () => {
		expect(mimeFromExtension('photo.jpg')).toBe('image/jpeg');
		expect(mimeFromExtension('photo.jpeg')).toBe('image/jpeg');
		expect(mimeFromExtension('PHOTO.JPG')).toBe('image/jpeg');
		expect(mimeFromExtension('shot.png')).toBe('image/png');
		expect(mimeFromExtension('frame.gif')).toBe('image/gif');
		expect(mimeFromExtension('asset.webp')).toBe('image/webp');
		expect(mimeFromExtension('pic.heic')).toBe('image/heic');
		expect(mimeFromExtension('pic.heif')).toBe('image/heif');
	});

	it('returns octet-stream for unknown / missing extensions', () => {
		expect(mimeFromExtension('strange.bin')).toBe('application/octet-stream');
		expect(mimeFromExtension('noextension')).toBe('application/octet-stream');
		expect(mimeFromExtension('')).toBe('application/octet-stream');
	});
});

describe('mimeToExtension', () => {
	it('round-trips the supported image mimes', () => {
		expect(mimeToExtension('image/jpeg')).toBe('jpg');
		expect(mimeToExtension('image/png')).toBe('png');
		expect(mimeToExtension('image/gif')).toBe('gif');
		expect(mimeToExtension('image/webp')).toBe('webp');
		expect(mimeToExtension('image/heic')).toBe('heic');
		expect(mimeToExtension('image/heif')).toBe('heif');
	});

	it('falls back to "bin" for unknown mimes', () => {
		expect(mimeToExtension('application/octet-stream')).toBe('bin');
		expect(mimeToExtension('text/plain')).toBe('bin');
	});
});

describe('isSupportedImageMime', () => {
	it('accepts the formats common vision models handle', () => {
		expect(isSupportedImageMime('image/jpeg')).toBe(true);
		expect(isSupportedImageMime('image/png')).toBe(true);
		expect(isSupportedImageMime('image/gif')).toBe(true);
		expect(isSupportedImageMime('image/webp')).toBe(true);
	});

	it('rejects HEIC/HEIF (most cloud models do not accept them as-is)', () => {
		expect(isSupportedImageMime('image/heic')).toBe(false);
		expect(isSupportedImageMime('image/heif')).toBe(false);
	});

	it('rejects non-images', () => {
		expect(isSupportedImageMime('application/pdf')).toBe(false);
		expect(isSupportedImageMime('text/plain')).toBe(false);
	});
});

describe('arrayBufferToBase64', () => {
	it('encodes a known sequence', () => {
		// bytes for "Hi!" = [0x48, 0x69, 0x21]
		const buf = new Uint8Array([0x48, 0x69, 0x21]).buffer;
		expect(arrayBufferToBase64(buf)).toBe('SGkh');
	});

	it('handles an empty buffer', () => {
		expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
	});

	it('handles non-ASCII bytes (e.g. JPEG header)', () => {
		// JPEG SOI marker FF D8 FF
		const buf = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
		expect(arrayBufferToBase64(buf)).toBe('/9j/');
	});

	it('encodes a large buffer correctly (regression — chunked path)', () => {
		// 100KB of repeating byte 0x41 ('A') — verifies the loop chunking
		// doesn't drop bytes or introduce padding glitches.
		const size = 100_000;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = 0x41;
		const out = arrayBufferToBase64(bytes.buffer);
		// 100000 bytes -> ceil(100000/3)*4 = 133336 chars
		expect(out.length).toBe(133336);
		expect(out.slice(0, 4)).toBe('QUFB'); // 'AAA' -> 'QUFB'
	});
});

describe('dataUrlFor', () => {
	it('builds a standard data URL', () => {
		expect(dataUrlFor('image/png', 'iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
	});
});

describe('attachImageToVault', () => {
	function buildApp(): { app: App; calls: { path: string; bytes: ArrayBuffer }[] } {
		const calls: { path: string; bytes: ArrayBuffer }[] = [];
		const app = new App();
		app.vault.createBinary = async (path: string, data: ArrayBuffer) => {
			calls.push({ path, bytes: data });
			return new TFile();
		};
		return { app, calls };
	}

	it('saves bytes under Obsidian\'s attachment path and returns the ImageBlock', async () => {
		const { app, calls } = buildApp();
		const buf = new Uint8Array([1, 2, 3]).buffer;
		const block = await attachImageToVault(app, buf, 'photo.jpg', 'image/jpeg');
		expect(block).toEqual({ type: 'image', path: 'attachments/photo.jpg', mime: 'image/jpeg' });
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe('attachments/photo.jpg');
	});

	it('mints a timestamped name when filename is empty', async () => {
		const { app, calls } = buildApp();
		await attachImageToVault(app, new ArrayBuffer(4), '', 'image/png');
		expect(calls[0].path).toMatch(/^attachments\/pasted-\d{8}T\d{6}\.png$/);
	});

	it('rejects HEIC with a clear error rather than silently uploading', async () => {
		const { app } = buildApp();
		await expect(attachImageToVault(app, new ArrayBuffer(4), 'photo.heic', 'image/heic')).rejects.toThrow(/HEIC|HEIF|not supported/i);
	});

	it('rejects non-image mimes', async () => {
		const { app } = buildApp();
		await expect(attachImageToVault(app, new ArrayBuffer(4), 'doc.pdf', 'application/pdf')).rejects.toThrow(/not supported/i);
	});
});

describe('suggestedImageName', () => {
	it('returns the provided filename when given a non-empty string', () => {
		expect(suggestedImageName('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
	});

	it('derives a timestamped name from the mime when no name is given', () => {
		const name = suggestedImageName('', 'image/png');
		expect(name).toMatch(/^pasted-\d{8}T\d{6}\.png$/);
	});

	it('uses bin extension for unknown mime when name is missing', () => {
		const name = suggestedImageName('', 'application/octet-stream');
		expect(name.endsWith('.bin')).toBe(true);
	});
});
