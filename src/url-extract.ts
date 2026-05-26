import { requestUrl } from 'obsidian';

/**
 * URL classification + content extraction for pinned-context URLs.
 *
 * Web pages: fetch HTML via `requestUrl` (bypasses CORS, works on iOS), parse
 * with the browser-native DOMParser, extract main article content. We
 * deliberately don't use @mozilla/readability — it adds ~30KB + a DOM-shim dep
 * for output polish the LLM doesn't need (the model reads raw words; it
 * doesn't care about clean formatting). The custom extractor below handles
 * the common shape (<article>, <main>, schema.org articleBody, or longest
 * text body) well enough for context-pin purposes.
 *
 * YouTube: scrape the watch page for `ytInitialPlayerResponse`, follow the
 * captions track URL, parse the timed XML transcript into plaintext. There is
 * no stable public API for transcripts; this is brittle by design. Surface
 * fetch failures loudly rather than masking with empty content so the user
 * knows when to find another source.
 */

export type UrlKind = 'web' | 'youtube' | 'unknown';

export interface WebExtract {
	kind: 'web';
	url: string;
	title: string;
	content: string;
	byline?: string;
	fetchedAt: number;
}

export interface YouTubeExtract {
	kind: 'youtube';
	url: string;
	videoId: string;
	title: string;
	channel: string;
	transcript: string;
	fetchedAt: number;
}

export type UrlExtract = WebExtract | YouTubeExtract;

const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);

export function classifyUrl(raw: string): { kind: UrlKind; normalized: string; videoId?: string } {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return { kind: 'unknown', normalized: trimmed };
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		// Allow bare "example.com/path" — retry with https://
		try {
			parsed = new URL('https://' + trimmed);
		} catch {
			return { kind: 'unknown', normalized: trimmed };
		}
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { kind: 'unknown', normalized: parsed.toString() };
	}
	const host = parsed.hostname.toLowerCase();
	if (YOUTUBE_HOSTS.has(host)) {
		const videoId = extractYouTubeId(parsed);
		if (videoId) return { kind: 'youtube', normalized: parsed.toString(), videoId };
		// youtube.com URL with no recognizable video id — channel page, playlist,
		// etc. Treat as a regular web page.
	}
	return { kind: 'web', normalized: parsed.toString() };
}

function extractYouTubeId(u: URL): string | null {
	if (u.hostname.toLowerCase() === 'youtu.be') {
		const id = u.pathname.replace(/^\/+/, '').split('/')[0];
		return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
	}
	const v = u.searchParams.get('v');
	if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
	const path = u.pathname;
	// /shorts/<id> and /embed/<id>
	const m = path.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{6,})/);
	if (m) return m[1];
	return null;
}

export interface FetchOpts {
	/**
	 * Cap the extracted plaintext at this many characters (post-cleanup).
	 * Mirrors `PinnedContext.MAX_BYTES_PER_FILE` so pinned URLs can't blow the
	 * context window by themselves. Default 25_000.
	 */
	maxChars?: number;
}

/**
 * Strip script/style/nav/header/footer/aside, then prefer (in order):
 *   1. <article>
 *   2. <main>
 *   3. [itemprop="articleBody"]
 *   4. <body>
 * Collapse whitespace, drop empty lines. Returns plaintext.
 */
export function extractFromHtml(html: string, opts: FetchOpts = {}): { title: string; content: string; byline?: string } {
	const max = opts.maxChars ?? 25_000;
	const doc = new DOMParser().parseFromString(html, 'text/html');

	const title = pickTitle(doc);
	const byline = pickByline(doc);

	for (const sel of ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'header', 'footer', 'aside']) {
		doc.querySelectorAll(sel).forEach((n) => n.remove());
	}

	const main =
		doc.querySelector('article') ||
		doc.querySelector('main') ||
		doc.querySelector('[itemprop="articleBody"]') ||
		doc.body;

	let text = main ? (main.textContent ?? '') : '';
	text = text.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	if (text.length > max) text = text.slice(0, max);
	return { title, content: text, byline };
}

function pickTitle(doc: Document): string {
	const og = doc.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
	if (og?.content) return og.content.trim();
	const h1 = doc.querySelector('h1');
	if (h1?.textContent) return h1.textContent.trim();
	return (doc.title || '').trim();
}

function pickByline(doc: Document): string | undefined {
	const author = doc.querySelector('meta[name="author"]') as HTMLMetaElement | null;
	if (author?.content) return author.content.trim();
	const ogAuthor = doc.querySelector('meta[property="article:author"]') as HTMLMetaElement | null;
	if (ogAuthor?.content) return ogAuthor.content.trim();
	return undefined;
}

export async function fetchWebPage(url: string, opts: FetchOpts = {}): Promise<WebExtract> {
	const res = await requestUrl({ url, method: 'GET', throw: false });
	if (res.status >= 400) {
		throw new Error(`Fetch failed (${res.status}) for ${url}`);
	}
	const ct = (res.headers?.['content-type'] || res.headers?.['Content-Type'] || '').toLowerCase();
	if (ct && !ct.includes('html') && !ct.includes('text/plain') && !ct.includes('xml')) {
		throw new Error(`Unsupported content-type ${ct} — only HTML/text pages can be pinned`);
	}
	const { title, content, byline } = extractFromHtml(res.text ?? '', opts);
	if (!content) throw new Error('Extracted no readable content from page');
	return {
		kind: 'web',
		url,
		title: title || url,
		content,
		byline,
		fetchedAt: Date.now(),
	};
}

export async function fetchYouTube(url: string, opts: FetchOpts = {}): Promise<YouTubeExtract> {
	const { kind, videoId, normalized } = classifyUrl(url);
	if (kind !== 'youtube' || !videoId) throw new Error('Not a recognizable YouTube video URL');

	// Canonical watch URL — youtu.be redirects + /embed/ pages don't always
	// embed ytInitialPlayerResponse in the same shape.
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
	const page = await requestUrl({ url: watchUrl, method: 'GET', throw: false });
	if (page.status >= 400) throw new Error(`YouTube page fetch failed (${page.status})`);
	const html = page.text ?? '';

	const playerResponse = extractPlayerResponse(html);
	if (!playerResponse) throw new Error('Could not parse ytInitialPlayerResponse — YouTube page shape changed');

	const title =
		playerResponse?.videoDetails?.title?.toString() ?? '';
	const channel =
		playerResponse?.videoDetails?.author?.toString() ?? '';

	const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
	if (!Array.isArray(tracks) || tracks.length === 0) {
		throw new Error('This video has no captions / transcript');
	}
	const track = pickCaptionTrack(tracks);
	if (!track?.baseUrl) throw new Error('Caption track has no fetch URL');

	const xmlRes = await requestUrl({ url: track.baseUrl, method: 'GET', throw: false });
	if (xmlRes.status >= 400) throw new Error(`Caption fetch failed (${xmlRes.status})`);
	const transcript = parseCaptionsXml(xmlRes.text ?? '', opts);
	if (!transcript) throw new Error('Caption XML produced no transcript text');

	return {
		kind: 'youtube',
		url: normalized,
		videoId,
		title: title || `YouTube video ${videoId}`,
		channel,
		transcript,
		fetchedAt: Date.now(),
	};
}

interface PlayerResponseShape {
	videoDetails?: { title?: unknown; author?: unknown };
	captions?: {
		playerCaptionsTracklistRenderer?: {
			captionTracks?: CaptionTrack[];
		};
	};
}

interface CaptionTrack {
	baseUrl?: string;
	languageCode?: string;
	kind?: string;
	vssId?: string;
}

function extractPlayerResponse(html: string): PlayerResponseShape | null {
	// YouTube embeds `var ytInitialPlayerResponse = {...};` (or assigns it via
	// `ytInitialPlayerResponse = `). Find the JSON literal that follows and
	// balance braces to slice it out.
	const markers = ['ytInitialPlayerResponse = ', 'ytInitialPlayerResponse"]='];
	for (const marker of markers) {
		const idx = html.indexOf(marker);
		if (idx < 0) continue;
		const start = html.indexOf('{', idx);
		if (start < 0) continue;
		const end = findMatchingBrace(html, start);
		if (end < 0) continue;
		const json = html.slice(start, end + 1);
		try {
			return JSON.parse(json) as PlayerResponseShape;
		} catch {
			continue;
		}
	}
	return null;
}

function findMatchingBrace(s: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === '\\') escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
	// Prefer manually-authored English; fall back to auto English; then first track.
	const manual = tracks.find((t) => (t.languageCode === 'en' || t.vssId?.startsWith('.en')) && t.kind !== 'asr');
	if (manual) return manual;
	const auto = tracks.find((t) => t.languageCode === 'en' || t.vssId?.startsWith('.en'));
	if (auto) return auto;
	return tracks[0];
}

function parseCaptionsXml(xml: string, opts: FetchOpts): string {
	const max = opts.maxChars ?? 25_000;
	const doc = new DOMParser().parseFromString(xml, 'text/xml');
	const lines: string[] = [];
	const texts = doc.getElementsByTagName('text');
	for (let i = 0; i < texts.length; i++) {
		const t = (texts[i].textContent ?? '').replace(/\s+/g, ' ').trim();
		if (t) lines.push(decodeXmlEntities(t));
	}
	let out = lines.join('\n');
	if (out.length > max) out = out.slice(0, max);
	return out;
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
