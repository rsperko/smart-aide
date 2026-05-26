import { describe, expect, it } from 'vitest';
import { classifyUrl } from '../src/url-extract';

// Note: extractFromHtml and the fetchWebPage / fetchYouTube wrappers all
// depend on the browser-native DOMParser, which is not available in vitest's
// node environment. We deliberately don't add happy-dom / jsdom just for these
// tests — DOMParser behavior is browser-defined, and the wrappers' logic
// (element selection priority, script/style stripping, maxChars cap) is
// straightforward enough to validate by dogfooding in Obsidian. classifyUrl
// is pure and gets full coverage below.

describe('classifyUrl', () => {
	it('classifies regular https URLs as web', () => {
		const out = classifyUrl('https://example.com/article');
		expect(out.kind).toBe('web');
		expect(out.normalized).toBe('https://example.com/article');
		expect(out.videoId).toBeUndefined();
	});

	it('handles bare hosts by prepending https://', () => {
		const out = classifyUrl('example.com/article');
		expect(out.kind).toBe('web');
		expect(out.normalized).toBe('https://example.com/article');
	});

	it('rejects non-http(s) schemes as unknown', () => {
		expect(classifyUrl('ftp://example.com/file').kind).toBe('unknown');
		expect(classifyUrl('javascript:alert(1)').kind).toBe('unknown');
		expect(classifyUrl('mailto:foo@bar').kind).toBe('unknown');
	});

	it('returns unknown for empty / whitespace input', () => {
		expect(classifyUrl('').kind).toBe('unknown');
		expect(classifyUrl('   ').kind).toBe('unknown');
		expect(classifyUrl('not a url').kind).toBe('unknown');
	});

	it('detects YouTube watch URLs and extracts the video id', () => {
		const a = classifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		expect(a.kind).toBe('youtube');
		expect(a.videoId).toBe('dQw4w9WgXcQ');

		const b = classifyUrl('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42');
		expect(b.kind).toBe('youtube');
		expect(b.videoId).toBe('dQw4w9WgXcQ');
	});

	it('detects youtu.be short URLs', () => {
		const out = classifyUrl('https://youtu.be/dQw4w9WgXcQ');
		expect(out.kind).toBe('youtube');
		expect(out.videoId).toBe('dQw4w9WgXcQ');
	});

	it('detects /shorts and /embed YouTube URLs', () => {
		expect(classifyUrl('https://www.youtube.com/shorts/abcDEF12345').videoId).toBe('abcDEF12345');
		expect(classifyUrl('https://www.youtube.com/embed/abcDEF12345').videoId).toBe('abcDEF12345');
	});

	it('falls back to web for youtube.com URLs with no video id (channel/home)', () => {
		expect(classifyUrl('https://www.youtube.com/@SomeChannel').kind).toBe('web');
		expect(classifyUrl('https://www.youtube.com/').kind).toBe('web');
	});

	it('handles mobile youtube hostname', () => {
		const out = classifyUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ');
		expect(out.kind).toBe('youtube');
		expect(out.videoId).toBe('dQw4w9WgXcQ');
	});
});

