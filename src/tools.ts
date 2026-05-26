import {
	App,
	TFile,
	getAllTags,
	normalizePath,
	parseFrontMatterAliases,
	prepareFuzzySearch,
	prepareSimpleSearch,
} from 'obsidian';
import type { ToolDescriptor } from './providers/types';
import { ApprovalPreview, Tool, ToolContext } from './types';

const DEFAULT_MAX_RESULTS = 10;
const DEEP_MAX_RESULTS = 25;
const HARD_MAX_RESULTS = 50;
const MAX_HITS_PER_FILE = 3;
const CONTENT_SNIPPET_PAD = 40;
const MAX_CONTENT_MATCHES_PER_FILE = 2;

// BM25 tuning constants. k1 = 1.2 and b = 0.75 are the Lucene / Elasticsearch
// defaults; 1.2–2.0 is the typical sane range for k1. The score formula keeps
// the (k1+1) numerator factor that Elasticsearch / Tantivy use (Lucene dropped
// it in LUCENE-8563); it's a constant scaling factor and doesn't affect rank.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// RRF constant. 60 is the value used by OpenSearch / Elasticsearch / Azure
// Search; the algorithm is famously tuning-free, so changing it is unlikely
// to help unless the surface count grows much larger.
const RRF_K = 60;

// Phrase boost. Standard BM25 is "bag of words" — term order and proximity are
// ignored ("New York" and "York New" score identically). We treat the adjacent
// phrase as an extra BM25 term and weight it so files containing the literal
// phrase rank above files where the words are merely scattered. 2x is a small
// boost in the explicit-boost range (1.5x–5x is typical).
const PHRASE_WEIGHT = 2;

// Fire fuzzy metadata as a TRUE last resort — only when exact metadata AND the
// content scan both returned zero. A higher threshold (e.g. fire when thin) was
// tried and reintroduced character-scatter noise (e.g. "thou art" → "The Four
// Agreements" via t-h-o-u-a-r-t scattered in order). The cleaner fix lives one
// layer up: ordering content scan *before* fuzzy means a real body match
// suppresses noisy fuzzy guesses.
const FUZZY_THRESHOLD = 1;

// Trigger an automatic body-content scan when metadata returns fewer than
// this many distinct files (or when the query is wrapped in quotes, or when
// deepSearch=true is set explicitly). Lifts the "Agent B has to retry with
// deepSearch=true" tax on natural-language queries.
const CONTENT_AUTO_THRESHOLD = 6;

// Mobile-safe file budget for an *auto* body scan (cachedRead is slow on
// iPhone first-cache). deepSearch=true lifts the cap to CONTENT_DEEP_FILE_BUDGET.
const CONTENT_AUTO_FILE_BUDGET = 200;
const CONTENT_DEEP_FILE_BUDGET = 2000;

// Stopwords the AND-gate strips before requiring every token to appear.
// Three groups:
//   1. English filler (articles, prepositions, copulas, pronouns).
//   2. Memory-recall verbs ("where did I WRITE about X", "the note I MENTIONED")
//      — these scaffold the question, not the answer. Critical for natural-
//      language recall: the body almost never contains the recall verb itself.
//   3. Question words.
// The exact phrase is always preserved separately for the phrase boost, so
// "to be or not to be" still ranks files with the phrase above the bag.
const STOPWORDS = new Set([
	'a', 'an', 'the',
	'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'as', 'by', 'about',
	'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
	'do', 'does', 'did', 'doing',
	'have', 'has', 'had', 'having',
	'i', 'you', 'me', 'my', 'your', 'we', 'us', 'our',
	'it', 'its', 'they', 'them', 'their',
	'that', 'this', 'these', 'those',
	'and', 'or', 'but', 'so', 'if', 'not', 'no',
	'write', 'wrote', 'written',
	'say', 'said', 'says',
	'mention', 'mentioned', 'mentions',
	'talk', 'talked', 'talks',
	'think', 'thought', 'thinks',
	'remember', 'remembered',
	'what', 'where', 'when', 'who', 'why', 'how', 'which',
]);

type HitWhere = 'filename' | 'alias' | 'heading' | 'tag' | 'linkDisplayText' | 'content';
const TIER_PRIORITY: Record<HitWhere, number> = {
	filename: 6,
	alias: 5,
	heading: 4,
	tag: 3,
	linkDisplayText: 2,
	content: 1,
};

interface Hit {
	in: HitWhere;
	text: string;
	score: number;
	line?: number;
	startLine?: number;
	endLine?: number;
	heading?: string;
	targetPath?: string;
	fuzzy?: boolean;
}

interface FileBucket {
	file: TFile;
	hits: Hit[];
}

const searchVault: Tool = {
	risk: 'read',
	name: 'search_vault',
	description: `Find notes by name, alias, heading, tag, wikilink display text, or body content.

Set ≥1 of: query, tag, pathPrefix, sinceDays (AND'd together).

query searches: filename · frontmatter aliases · headings · tags · wikilink display text. Bodies are scanned automatically when metadata returns few hits, when the query is quoted, or when deepSearch=true. The response's autoBody field tells you when a body scan ran without being asked.

If exact matching is thin, a fuzzy character-order pass runs automatically (catches typos / partial recall / abbreviations). Response sets fuzzyFallback=true when this fired — treat those hits as approximate.

Each hit carries in: "filename" | "alias" | "heading" | "tag" | "linkDisplayText" | "content" so you can cite the match accurately ("matched alias: PascalCase"). matchedSurfaces on each result lists every surface that fired for that file — multi-surface matches are stronger.

Use the user's exact remembered phrase. Don't paraphrase.

Folders in Obsidian's Excluded files setting are skipped — unless pathPrefix points at one (explicit > default).

Examples:
- "find my weekly review notes" → query="weekly review"
- "where I wrote 'eventual consistency'" → query="\\"eventual consistency\\"" (quotes force body scan)
- "PascalCase note" → query="PascalCase" (likely matches an alias)
- "support characters concept" → query="support characters" (often hits link display text)
- "the note about A to C" → query="A to C"
- "tagged book" → tag="book"
- "in my Daily folder" → pathPrefix="Daily"
- "recent deadline notes" → query="deadline", sinceDays=30
- "any mention of Postgres" → query="Postgres" (auto-scans body if metadata is thin)
- "force a full-vault body scan" → query="…", deepSearch=true

For vague concepts, fire 2–3 parallel calls with synonyms — "find that piece on deep work" → query="deep work" + "deepwork" + "flow". Cheap.

Heading hits AND content hits include startLine + endLine + heading — pass them to read_note for just the surrounding section. linkDisplayText hits include targetPath — read that path directly. Read the hint field when matches=0.`,
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: "User's exact remembered words. Wrap in quotes to force a body phrase match.",
			},
			tag: {
				type: 'string',
				description: "Exact tag (# optional). NOT fuzzy: 'task' ≠ 'tasks'. For fuzzy, use query.",
			},
			pathPrefix: {
				type: 'string',
				description: "Folder to limit to, e.g. 'Daily' or 'Projects/Q4'.",
			},
			sinceDays: {
				type: 'integer',
				description: "Modified within N days. Use for 'recent' / 'last week'.",
			},
			deepSearch: {
				type: 'boolean',
				description: "Force a full-vault body scan. Lifts the auto-body file budget. Rarely needed — the tool already auto-scans bodies when metadata is thin or the query is quoted.",
			},
			maxResults: {
				type: 'integer',
				description: `Default ${DEFAULT_MAX_RESULTS}, cap ${HARD_MAX_RESULTS}.`,
			},
		},
	},
	async execute(args, ctx) {
		const rawQuery = strArg(args.query);
		const query = stripEnclosingQuotes(rawQuery);
		const wasQuoted = rawQuery !== query && query.length > 0;
		const tag = normalizeTag(strArg(args.tag));
		const pathPrefix = strArg(args.pathPrefix);
		const sinceDays = intArg(args.sinceDays);
		const deepSearch = !!args.deepSearch;

		if (!query && !tag && !pathPrefix && sinceDays === undefined) {
			return JSON.stringify({
				error: 'Provide at least one of: query, tag, pathPrefix, sinceDays.',
			});
		}

		const sinceMs = sinceDays !== undefined ? Date.now() - sinceDays * 86_400_000 : 0;

		let files = ctx.app.vault.getMarkdownFiles();
		const normalizedPrefix = pathPrefix ? normalizePathPrefix(pathPrefix) : '';
		if (normalizedPrefix) {
			files = files.filter((f) => matchesPathPrefix(f.path, normalizedPrefix));
		}
		if (sinceDays !== undefined) files = files.filter((f) => f.stat.mtime >= sinceMs);
		if (tag) {
			files = files.filter((f) => {
				const cache = ctx.app.metadataCache.getFileCache(f);
				if (!cache) return false;
				const tags = (getAllTags(cache) ?? []).map((t) => t.toLowerCase());
				return tags.includes(tag);
			});
		}

		// Honor Obsidian's vault-wide "Excluded files" setting unless the user's
		// pathPrefix points at (or under) an excluded root — explicit > default.
		const ignoreFilters = getUserIgnoreFilters(ctx.app);
		if (ignoreFilters.length > 0) {
			const prefixOverrides =
				normalizedPrefix && isUserIgnored(ignoreFilters, normalizedPrefix);
			if (!prefixOverrides) {
				files = files.filter((f) => !isUserIgnored(ignoreFilters, f.path));
			}
		}

		const buckets = new Map<string, FileBucket>();
		let fuzzyFallback = false;

		const record = (file: TFile, hit: Hit) => {
			let b = buckets.get(file.path);
			if (!b) {
				b = { file, hits: [] };
				buckets.set(file.path, b);
			}
			b.hits.push(hit);
		};

		if (query) {
			// Single metadata pass over every (file, cache) pair. Each surface
			// (filename, alias, heading, tag, linkDisplayText) records hits
			// independently so RRF can fuse them.
			const search = prepareSimpleSearch(query);
			for (const file of files) {
				const fr = search(file.basename);
				if (fr) record(file, { in: 'filename', text: file.basename, score: fr.score });

				const cache = ctx.app.metadataCache.getFileCache(file);
				if (!cache) continue;

				for (const alias of parseFrontMatterAliases(cache.frontmatter) ?? []) {
					const r = search(alias);
					if (r) record(file, { in: 'alias', text: alias, score: r.score });
				}

				const headings = cache.headings ?? [];
				for (let i = 0; i < headings.length; i++) {
					const h = headings[i];
					const r = search(h.heading);
					if (!r) continue;
					const startLine = h.position.start.line + 1;
					const endLine = sectionEndLine(
						headings,
						i,
						file.stat.size > 0 ? Number.MAX_SAFE_INTEGER : startLine,
					);
					record(file, {
						in: 'heading',
						text: h.heading,
						score: r.score,
						startLine,
						endLine,
					});
				}

				for (const t of getAllTags(cache) ?? []) {
					const r = search(t);
					if (r) record(file, { in: 'tag', text: t, score: r.score });
				}

				for (const link of cache.links ?? []) {
					const text = link.displayText || link.link;
					if (!text) continue;
					const r = search(text);
					if (!r) continue;
					const dest = ctx.app.metadataCache.getFirstLinkpathDest?.(link.link, file.path);
					record(file, {
						in: 'linkDisplayText',
						text,
						score: r.score,
						targetPath: dest?.path,
					});
				}
				for (const link of cache.frontmatterLinks ?? []) {
					const text = link.displayText || link.link;
					if (!text) continue;
					const r = search(text);
					if (!r) continue;
					const dest = ctx.app.metadataCache.getFirstLinkpathDest?.(link.link, file.path);
					record(file, {
						in: 'linkDisplayText',
						text,
						score: r.score,
						targetPath: dest?.path,
					});
				}
			}

		} else {
			// No query - just filter-based listing
			for (const file of files) {
				record(file, { in: 'filename', text: file.basename, score: 0 });
			}
		}

		// Content scan — runs when:
		//   - deepSearch=true (explicit, full file budget), OR
		//   - the query was wrapped in quotes (user is quoting a body phrase), OR
		//   - exact metadata returned fewer than CONTENT_AUTO_THRESHOLD files.
		// Runs BEFORE fuzzy fallback so a real body match suppresses noisy
		// character-scatter fuzzy guesses. Multi-surface match (filename +
		// content) is the strongest RRF signal, so content hits CAN add to
		// already-bucketed files — that's the win.
		let autoBody = false;
		if (query && (deepSearch || wasQuoted || buckets.size < CONTENT_AUTO_THRESHOLD)) {
			const fileBudget = deepSearch ? CONTENT_DEEP_FILE_BUDGET : CONTENT_AUTO_FILE_BUDGET;
			// Bucketed files first (cheap multi-surface confirmation), then most
			// recently modified — recency is the closest mobile-safe proxy for
			// "likely to be the one the user means."
			const ordered = [...files].sort((a, b) => {
				const aB = buckets.has(a.path) ? 0 : 1;
				const bB = buckets.has(b.path) ? 0 : 1;
				if (aB !== bB) return aB - bB;
				return b.stat.mtime - a.stat.mtime;
			});
			const filesToScan = ordered.slice(0, fileBudget);
			await runContentScan(ctx, filesToScan, query, record, !deepSearch);
			autoBody = !deepSearch;
		}

		// Fuzzy fallback — true last resort. Only fires when nothing above
		// matched. See FUZZY_THRESHOLD for why we don't fire on thin results.
		if (query && buckets.size < FUZZY_THRESHOLD) {
			const before = buckets.size;
			const fuzzy = prepareFuzzySearch(query);
			for (const file of files) {
				const fr = fuzzy(file.basename);
				if (fr) record(file, { in: 'filename', text: file.basename, score: fr.score, fuzzy: true });

				const cache = ctx.app.metadataCache.getFileCache(file);
				if (!cache) continue;

				for (const alias of parseFrontMatterAliases(cache.frontmatter) ?? []) {
					const r = fuzzy(alias);
					if (r) record(file, { in: 'alias', text: alias, score: r.score, fuzzy: true });
				}

				const headings = cache.headings ?? [];
				for (let i = 0; i < headings.length; i++) {
					const h = headings[i];
					const r = fuzzy(h.heading);
					if (!r) continue;
					const startLine = h.position.start.line + 1;
					const endLine = sectionEndLine(
						headings,
						i,
						file.stat.size > 0 ? Number.MAX_SAFE_INTEGER : startLine,
					);
					record(file, {
						in: 'heading',
						text: h.heading,
						score: r.score,
						startLine,
						endLine,
						fuzzy: true,
					});
				}

				for (const t of getAllTags(cache) ?? []) {
					const r = fuzzy(t);
					if (r) record(file, { in: 'tag', text: t, score: r.score, fuzzy: true });
				}
			}
			if (buckets.size > before) fuzzyFallback = true;
		}

		// RRF across every (surface, fuzzy?) pair. Splitting exact vs fuzzy means
		// an exact filename hit always outranks a fuzzy filename hit even though
		// both end up labelled `in: "filename"` in the response. Files that
		// appear strongly across multiple surfaces accumulate more.
		const rrfScores = computeRrfScores(buckets);
		const ranked = [...buckets.values()].sort((a, b) => {
			const aScore = rrfScores.get(a.file.path) ?? 0;
			const bScore = rrfScores.get(b.file.path) ?? 0;
			if (bScore !== aScore) return bScore - aScore;
			return b.file.stat.mtime - a.file.stat.mtime;
		});

		const defaultMax = deepSearch ? DEEP_MAX_RESULTS : DEFAULT_MAX_RESULTS;
		const maxResults = clamp(intArg(args.maxResults) ?? defaultMax, 1, HARD_MAX_RESULTS);
		const sliced = ranked.slice(0, maxResults);
		const results = sliced.map((b) => {
			const matchedSurfaces = [...new Set(b.hits.map((h) => h.in))];
			return {
				path: b.file.path,
				mtime: isoDate(b.file.stat.mtime),
				matchedSurfaces,
				hits: b.hits
					.sort((a, h) => TIER_PRIORITY[h.in] - TIER_PRIORITY[a.in] || h.score - a.score)
					.slice(0, MAX_HITS_PER_FILE)
					.map(compactHit),
			};
		});

		const response: Record<string, unknown> = {
			matches: ranked.length,
			returned: results.length,
			deepSearch,
			results,
		};
		if (autoBody) response.autoBody = true;
		if (fuzzyFallback) response.fuzzyFallback = true;
		if (ranked.length === 0) {
			response.hint = emptyHint({ query, tag, pathPrefix, sinceDays, deepSearch });
		} else if (ranked.length > maxResults) {
			response.hint = `Showing top ${maxResults} of ${ranked.length}. Narrow with pathPrefix, tag, or sinceDays.`;
		}
		return JSON.stringify(response);
	},
};

// Auto-body scans (not deepSearch=true) bail after this many milliseconds.
// Note sizes vary wildly, so an elapsed-time budget guards iPhone
// responsiveness better than a fixed file count.
const AUTO_BODY_TIME_BUDGET_MS = 1500;

async function runContentScan(
	ctx: ToolContext,
	filesToScan: TFile[],
	query: string,
	record: (file: TFile, hit: Hit) => void,
	enforceTimeBudget: boolean,
): Promise<void> {
	const sig = significantTokens(query);
	const phrase = normalizeForMatch(query);
	let phraseTokenCount = 0;
	{
		let inWord = false;
		for (let i = 0; i < phrase.length; i++) {
			const c = phrase.charCodeAt(i);
			const isSpace = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
			if (isSpace) inWord = false;
			else if (!inWord) { inWord = true; phraseTokenCount++; }
		}
	}
	const isMultiToken = phraseTokenCount > 1;
	// "A to C", "the of", etc. — the gate strips everything; only the literal
	// phrase carries signal. Require the phrase to be present, no per-token gate.
	const allWeak = sig.length === 0;

	// Per-file record retains only NUMERIC stats and (when the gate passes)
	// the small `hits` array — never the raw content. content + normalized go
	// out of scope at the end of each loop body, releasing potentially
	// megabytes per file across a deep scan.
	interface ContentDoc {
		file: TFile;
		dl: number;
		tf: number[];
		phraseTf: number;
		passesGate: boolean;
		hits: Hit[];
	}
	const scanned: ContentDoc[] = [];
	const startMs = Date.now();
	for (const file of filesToScan) {
		if (enforceTimeBudget && Date.now() - startMs > AUTO_BODY_TIME_BUDGET_MS) break;
		const content = await ctx.app.vault.cachedRead(file);
		const normalized = normalizeForMatch(content);
		const tf = sig.map((t) => countWordOccurrencesNormalized(normalized, t));
		const phraseTf = isMultiToken ? countWordOccurrencesNormalized(normalized, phrase) : 0;
		const passesGate = allWeak ? phraseTf > 0 : tf.every((c) => c > 0);
		const dl = Math.max(1, countWords(content));

		const hits: Hit[] = [];
		if (passesGate) {
			// Score field is filled in pass 2 once IDF is known; build snippets
			// + heading context now while we still have the strings.
			let matches = isMultiToken
				? findWordMatchesNormalized(content, normalized, phrase, MAX_CONTENT_MATCHES_PER_FILE)
				: [];
			if (matches.length === 0) {
				const probes = sig.length > 0 ? sig : [phrase];
				for (const probe of probes) {
					matches = findWordMatchesNormalized(content, normalized, probe, MAX_CONTENT_MATCHES_PER_FILE);
					if (matches.length > 0) break;
				}
			}
			const cache = ctx.app.metadataCache.getFileCache(file);
			const headings = cache?.headings ?? [];
			const totalLines = countNewlines(content) + 1;
			for (const m of matches) {
				const enclosing = findEnclosingHeading(headings, m.line, totalLines);
				const hit: Hit = { in: 'content', text: m.snippet, line: m.line, score: 0 };
				if (enclosing) {
					hit.heading = enclosing.heading;
					hit.startLine = enclosing.startLine;
					hit.endLine = enclosing.endLine;
				}
				hits.push(hit);
			}
		}
		scanned.push({ file, dl, tf, phraseTf, passesGate, hits });
		// content + normalized fall out of scope here.
	}

	const hasCandidates = scanned.some((d) => d.passesGate);
	if (!hasCandidates) return;

	// IDF over the scanned corpus (not just candidates) — corrects the previous
	// bug where DF was measured AFTER the AND-gate, so every term looked common.
	const N = Math.max(1, scanned.length);
	let totalDl = 0;
	for (const d of scanned) totalDl += d.dl;
	const avgdl = totalDl / N;
	const idf = sig.map((_, ti) => {
		let df = 0;
		for (const d of scanned) if (d.tf[ti] > 0) df++;
		return Math.log((N - df + 0.5) / (df + 0.5) + 1);
	});
	let phraseIdf = 0;
	if (isMultiToken) {
		let dfPhrase = 0;
		for (const d of scanned) if (d.phraseTf > 0) dfPhrase++;
		phraseIdf = Math.log((N - dfPhrase + 0.5) / (dfPhrase + 0.5) + 1);
	}

	for (const c of scanned) {
		if (!c.passesGate) continue;
		let score = 0;
		for (let ti = 0; ti < sig.length; ti++) {
			score += bm25TermScore(c.tf[ti], c.dl, avgdl, idf[ti]);
		}
		if (isMultiToken && c.phraseTf > 0) {
			score += PHRASE_WEIGHT * bm25TermScore(c.phraseTf, c.dl, avgdl, phraseIdf);
		}
		for (const h of c.hits) {
			h.score = score;
			record(c.file, h);
		}
	}
}

function findEnclosingHeading(
	headings: { heading: string; level: number; position: { start: { line: number } } }[],
	line: number,
	totalLines: number,
): { heading: string; startLine: number; endLine: number } | null {
	if (headings.length === 0) return null;
	let best = -1;
	for (let i = 0; i < headings.length; i++) {
		if (headings[i].position.start.line + 1 <= line) best = i;
		else break;
	}
	if (best < 0) return null;
	const h = headings[best];
	return {
		heading: h.heading,
		startLine: h.position.start.line + 1,
		endLine: sectionEndLine(headings, best, totalLines),
	};
}

const AUTO_TRUNCATE_BYTES = 60_000;
const TRUNCATED_RETURN_BYTES = 25_000;

const readNote: Tool = {
	risk: 'read',
	name: 'read_note',
	description: `Read note content. Three modes:

1. Full: {path}. Auto-truncates >${Math.round(AUTO_TRUNCATE_BYTES / 1000)}KB to first ~${Math.round(TRUNCATED_RETURN_BYTES / 1000)}KB + heading outline; response has truncated=true and a hint.
2. Range: {path, startLine, endLine}. 1-indexed inclusive. Use startLine+endLine from a search_vault heading hit.
3. Section: {path, section: "Setup"}. Case-insensitive heading match (exact then fuzzy). Returns until next same-or-higher heading. If no match, response lists available headings.

Examples:
- "show Setup section" → {path, section: "Setup"}
- hit had startLine:23, endLine:41 → {path, startLine:23, endLine:41}
- "summarize this note" → {path}
- continue a truncated read → {path, startLine: <continueAt>}`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative .md path.' },
			startLine: { type: 'integer', description: '1-indexed first line (inclusive).' },
			endLine: { type: 'integer', description: '1-indexed last line (inclusive). Default: EOF.' },
			section: { type: 'string', description: 'Heading name. Ignored if startLine/endLine given.' },
		},
		required: ['path'],
	},
	async execute(args, ctx) {
		const rawPath = strArg(args.path);
		if (!rawPath) return JSON.stringify({ error: 'path is required' });
		const path = normalizePath(rawPath);
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return JSON.stringify({ error: guard });
		const file = ctx.app.vault.getFileByPath(path);
		if (!file) {
			return JSON.stringify({ error: `not a file or not found: ${path}` });
		}

		const mtime = isoDate(file.stat.mtime);
		const full = await ctx.app.vault.cachedRead(file);
		const lines = full.split('\n');
		const totalLines = lines.length;

		const explicitStart = intArg(args.startLine);
		const explicitEnd = intArg(args.endLine);
		const section = strArg(args.section);

		// Mode 2: explicit range
		if (explicitStart !== undefined || explicitEnd !== undefined) {
			return rangeResponse(path, mtime, lines, explicitStart, explicitEnd, totalLines);
		}

		// Mode 3: section by heading
		if (section) {
			const cache = ctx.app.metadataCache.getFileCache(file);
			const headings = cache?.headings ?? [];
			if (headings.length === 0) {
				return JSON.stringify({
					error: `no headings in this file; cannot use section=`,
					path,
					mtime,
				});
			}
			const matchIdx = findSectionIndex(headings, section);
			if (matchIdx < 0) {
				return JSON.stringify({
					error: `no heading matches "${section}"`,
					path,
					mtime,
					availableHeadings: headings.map((h) => h.heading),
				});
			}
			const startLine = headings[matchIdx].position.start.line + 1;
			const endLine = sectionEndLine(headings, matchIdx, totalLines);
			return rangeResponse(path, mtime, lines, startLine, endLine, totalLines);
		}

		// Mode 1: full file — possibly auto-truncated
		if (full.length > AUTO_TRUNCATE_BYTES) {
			let truncateAt = TRUNCATED_RETURN_BYTES;
			const nextNewline = full.indexOf('\n', truncateAt);
			if (nextNewline > 0) truncateAt = nextNewline;
			const truncatedContent = full.slice(0, truncateAt);
			const returnedLines = truncatedContent.split('\n').length;

			const cache = ctx.app.metadataCache.getFileCache(file);
			const outline = (cache?.headings ?? []).map((h) => ({
				heading: h.heading,
				level: h.level,
				line: h.position.start.line + 1,
			}));

			return JSON.stringify({
				path,
				mtime,
				truncated: true,
				startLine: 1,
				endLine: returnedLines,
				totalLines,
				bytes: full.length,
				outline,
				hint:
					`File is ${full.length} bytes / ${totalLines} lines. ` +
					`Returned first ${returnedLines} lines. ` +
					`To read more: read_note(path, startLine=${returnedLines + 1}) for the next chunk, ` +
					`or read_note(path, section="...") to jump to a heading from outline.`,
				content: truncatedContent,
			});
		}

		return JSON.stringify({
			path,
			mtime,
			lines: totalLines,
			content: full,
		});
	},
};

const writeNote: Tool = {
	risk: 'write',
	name: 'write_note',
	description: `Create or overwrite a note. REQUIRES APPROVAL — diff shown.

For adding to the end without touching existing content, prefer append_to_note (smaller diff).

Use Obsidian markdown (see system prompt). Body MUST NOT start with \`# <Filename>\` — Obsidian renders filename as title.

Examples:
- "create Daily/2026-05-21.md with X" → write_note(path, content)
- "rewrite this section" → read_note first, then write_note with full new content`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative .md path.' },
			content: { type: 'string', description: 'Full new note content.' },
		},
		required: ['path', 'content'],
	},
	async preview(args, ctx): Promise<ApprovalPreview> {
		const path = normalizePath(strArg(args.path));
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return { summary: `Blocked write ${path} — ${guard}` };
		const file = ctx.app.vault.getFileByPath(path);
		const oldContent = file ? await ctx.app.vault.read(file) : '';
		const newContent = stripDuplicateTitleHeading(path, strArg(args.content));
		return {
			summary: file ? `Overwrite ${path}` : `Create ${path}`,
			diff: { kind: 'overwrite', path, oldContent, newContent },
		};
	},
	async execute(args, ctx) {
		const path = normalizePath(strArg(args.path));
		if (!path) return JSON.stringify({ error: 'path is required' });
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return JSON.stringify({ error: guard });
		const content = stripDuplicateTitleHeading(path, strArg(args.content));
		const existing = ctx.app.vault.getFileByPath(path);
		if (existing) {
			await ctx.app.vault.process(existing, () => content);
			return JSON.stringify({ status: 'overwritten', path });
		}
		// Ensure parent folder exists
		const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (parent && !(await ctx.app.vault.adapter.exists(parent))) {
			await ctx.app.vault.createFolder(parent);
		}
		await ctx.app.vault.create(path, content);
		return JSON.stringify({ status: 'created', path });
	},
};

const appendToNote: Tool = {
	risk: 'write',
	name: 'append_to_note',
	description: `Append to an existing note. REQUIRES APPROVAL — content shown.

Lower friction than write_note when only adding. Note must exist; use write_note to create. Use Obsidian markdown (see system prompt).

Examples:
- "add a TODO to today's daily note" → append_to_note(path, "\\n- [ ] follow up with [[Bob]]")
- "log this insight in my journal" → append_to_note(path, content)`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative .md path.' },
			content: { type: 'string', description: 'Text to append. Lead with newlines for spacing.' },
		},
		required: ['path', 'content'],
	},
	async preview(args, ctx): Promise<ApprovalPreview> {
		const path = normalizePath(strArg(args.path));
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return { summary: `Blocked append ${path} — ${guard}` };
		const file = ctx.app.vault.getFileByPath(path);
		const newContent = strArg(args.content);
		return {
			summary: file ? `Append to ${path}` : `Cannot append — ${path} does not exist`,
			diff: { kind: 'append', path, newContent },
		};
	},
	async execute(args, ctx) {
		const path = normalizePath(strArg(args.path));
		if (!path) return JSON.stringify({ error: 'path is required' });
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return JSON.stringify({ error: guard });
		const file = ctx.app.vault.getFileByPath(path);
		if (!file) return JSON.stringify({ error: `not found: ${path}` });
		// Don't trim — the tool description tells the model to use leading
		// newlines for spacing, so trimming silently breaks that contract.
		const content = typeof args.content === 'string' ? args.content : '';
		await ctx.app.vault.append(file, content);
		return JSON.stringify({ status: 'appended', path });
	},
};

const deleteNote: Tool = {
	risk: 'delete',
	name: 'delete_note',
	description: `Move a note to trash. REQUIRES CONFIRMATION. Only when user explicitly asks to delete — never to "clean up" automatically.`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative .md path.' },
		},
		required: ['path'],
	},
	async preview(args, ctx): Promise<ApprovalPreview> {
		const path = normalizePath(strArg(args.path));
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return { summary: `Blocked delete ${path} — ${guard}` };
		const file = ctx.app.vault.getFileByPath(path);
		const oldContent = file ? await ctx.app.vault.read(file) : '';
		return {
			summary: `Delete ${path}`,
			diff: { kind: 'delete', path, oldContent },
		};
	},
	async execute(args, ctx) {
		const path = normalizePath(strArg(args.path));
		if (!path) return JSON.stringify({ error: 'path is required' });
		const guard = pathGuard(path, ctx.metaDir, { requireMarkdown: true });
		if (guard) return JSON.stringify({ error: guard });
		const file = ctx.app.vault.getFileByPath(path);
		if (!file) return JSON.stringify({ error: `not found: ${path}` });
		await ctx.app.fileManager.trashFile(file);
		return JSON.stringify({ status: 'deleted', path });
	},
};

const listRecent: Tool = {
	risk: 'read',
	name: 'list_recent',
	description: `Most-recently-modified notes. Use for "what did I write recently", "today's daily notes", "recent journal entries". Returns path + mtime, newest first.`,
	parameters: {
		type: 'object',
		properties: {
			pathPrefix: { type: 'string', description: "Optional folder, e.g. 'Daily'." },
			limit: { type: 'integer', description: 'Default 10, cap 50.' },
		},
	},
	async execute(args, ctx) {
		const pathPrefix = strArg(args.pathPrefix);
		const limit = clamp(intArg(args.limit) ?? 10, 1, 50);
		let files = ctx.app.vault.getMarkdownFiles();
		const normalizedPrefix = pathPrefix ? normalizePathPrefix(pathPrefix) : '';
		if (normalizedPrefix) {
			files = files.filter((f) => matchesPathPrefix(f.path, normalizedPrefix));
		}
		const ignoreFilters = getUserIgnoreFilters(ctx.app);
		if (ignoreFilters.length > 0) {
			const prefixOverrides =
				normalizedPrefix && isUserIgnored(ignoreFilters, normalizedPrefix);
			if (!prefixOverrides) {
				files = files.filter((f) => !isUserIgnored(ignoreFilters, f.path));
			}
		}
		files.sort((a, b) => b.stat.mtime - a.stat.mtime);
		const results = files.slice(0, limit).map((f) => ({
			path: f.path,
			mtime: isoDate(f.stat.mtime),
		}));
		return JSON.stringify({ count: results.length, results });
	},
};

const getBacklinks: Tool = {
	risk: 'read',
	name: 'get_backlinks',
	description: `Notes that link TO a given note. Use for "what links to this", "what references X", "where is this discussed". Returns paths sorted by link count.`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative target path.' },
		},
		required: ['path'],
	},
	async execute(args, ctx) {
		const rawPath = strArg(args.path);
		if (!rawPath) return JSON.stringify({ error: 'path is required' });
		const target = normalizePath(rawPath);
		const links = ctx.app.metadataCache.resolvedLinks;
		const ignoreFilters = getUserIgnoreFilters(ctx.app);
		const backlinks: { path: string; count: number }[] = [];
		for (const [source, targets] of Object.entries(links)) {
			if (ignoreFilters.length > 0 && isUserIgnored(ignoreFilters, source)) continue;
			const count = (targets as Record<string, number>)[target];
			if (count > 0) backlinks.push({ path: source, count });
		}
		backlinks.sort((a, b) => b.count - a.count);
		return JSON.stringify({ target, count: backlinks.length, results: backlinks });
	},
};

export const TOOLS: Tool[] = [searchVault, readNote, writeNote, appendToNote, deleteNote, listRecent, getBacklinks];

export const LOAD_SKILL_NAME = 'load_skill';

// load_skill is exposed to the model but executed by the view layer, which has
// the SkillRegistry + active session needed to persist the loaded body as a
// custom_message entry. Routed past dispatchTool entirely.
export const LOAD_SKILL_TOOL_DEF: ToolDescriptor = {
	name: LOAD_SKILL_NAME,
	description: `Load a skill's full body. Skill names + descriptions are in your system prompt — call this when the user's request matches one.

Examples:
- User wants daily log template, skill 'daily-log' exists → load_skill('daily-log')
- User wants meeting recap, skill 'meeting-notes' exists → load_skill('meeting-notes')`,
	parameters: {
		type: 'object',
		properties: {
			name: { type: 'string', description: "Skill name from the manifest." },
		},
		required: ['name'],
	},
};

export function toolsToDescriptors(tools: Tool[]): ToolDescriptor[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

export async function dispatchTool(
	tools: Tool[],
	name: string,
	args: Record<string, unknown>,
	app: App,
	metaDir: string,
): Promise<string> {
	const tool = tools.find((t) => t.name === name);
	if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` });
	try {
		return await tool.execute(args, { app, metaDir });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return JSON.stringify({ error: `tool ${name} failed: ${msg}` });
	}
}

function sectionEndLine(
	headings: { heading: string; level: number; position: { start: { line: number } } }[],
	index: number,
	fallback: number,
): number {
	const here = headings[index];
	for (let j = index + 1; j < headings.length; j++) {
		if (headings[j].level <= here.level) {
			return headings[j].position.start.line;
		}
	}
	return fallback;
}

export function findSectionIndex(
	headings: { heading: string }[],
	section: string,
): number {
	const targetLower = section.toLowerCase();
	const exactIdx = headings.findIndex((h) => h.heading.toLowerCase() === targetLower);
	if (exactIdx >= 0) return exactIdx;
	const search = prepareSimpleSearch(section);
	let bestScore = -Infinity;
	let bestIdx = -1;
	for (let i = 0; i < headings.length; i++) {
		const r = search(headings[i].heading);
		if (r && r.score > bestScore) {
			bestScore = r.score;
			bestIdx = i;
		}
	}
	return bestIdx;
}

function rangeResponse(
	path: string,
	mtime: string,
	lines: string[],
	startLine: number | undefined,
	endLine: number | undefined,
	totalLines: number,
): string {
	const from = (startLine ?? 1) - 1;
	const to = endLine ?? totalLines;
	const slice = lines.slice(Math.max(0, from), Math.min(totalLines, to));
	return JSON.stringify({
		path,
		mtime,
		startLine: from + 1,
		endLine: from + slice.length,
		totalLines,
		content: slice.join('\n'),
	});
}

/**
 * Lowercase + Unicode-normalize + collapse hyphens/underscores/slashes to
 * spaces so `deep-work`, `deep_work`, and `deep work` are equivalent under
 * word-boundary matching. Used by both the content gate and the content
 * snippet finder.
 */
export function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.replace(/[-_/]+/g, ' ');
}

/**
 * Tokens worth requiring in the BM25 AND-gate. Drops English stopwords and
 * length-1 tokens; falls back to the raw lowercase tokens when the strip
 * would leave nothing (so "A to C" still keeps something to score against).
 * The exact phrase is always preserved separately for the phrase boost.
 */
export function significantTokens(s: string): string[] {
	const normalized = normalizeForMatch(s);
	const raw = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const filtered = raw.filter((t) => t.length > 1 && !STOPWORDS.has(t));
	return filtered.length > 0 ? filtered : [];
}

export function countWordOccurrencesNormalized(normalizedContent: string, normalizedNeedle: string): number {
	if (!normalizedNeedle) return 0;
	// exec loop instead of .match() — match() allocates an array containing
	// every match string, which on a deep scan of 2000 files × 3 tokens is
	// thousands of throwaway arrays.
	const re = new RegExp(`\\b${escapeRegex(normalizedNeedle)}\\b`, 'g');
	let count = 0;
	while (re.exec(normalizedContent) !== null) count++;
	return count;
}

/**
 * Allocation-light word count. Avoids `s.split(/\s+/).length`, which allocates
 * an array proportional to file size on every call — meaningful when the
 * content scan opens hundreds of files in one tool call.
 */
export function countWords(s: string): number {
	let count = 0;
	let inWord = false;
	for (let i = 0, n = s.length; i < n; i++) {
		const c = s.charCodeAt(i);
		const isSpace = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
		if (isSpace) {
			inWord = false;
		} else if (!inWord) {
			inWord = true;
			count++;
		}
	}
	return count;
}

/**
 * Count `\n` without allocating. Used for total-lines + per-match line
 * numbers in the body scan.
 */
export function countNewlines(s: string, endExclusive?: number): number {
	const end = endExclusive ?? s.length;
	let n = 0;
	for (let i = 0; i < end; i++) {
		if (s.charCodeAt(i) === 0x0a) n++;
	}
	return n;
}

/**
 * Find matches in the *normalized* content but return snippets and line
 * numbers from the original. The two share character positions because
 * normalization is 1-for-1 (hyphen→space) — no inserts or deletes.
 *
 * Line numbers are tracked incrementally as the regex advances through the
 * string — the old `slice(0, lineStart).split('\n').length` allocated a copy
 * of the prefix for every match, which scaled badly for files with many hits.
 */
export function findWordMatchesNormalized(
	original: string,
	normalized: string,
	normalizedNeedle: string,
	max: number,
): { line: number; snippet: string }[] {
	if (!normalizedNeedle) return [];
	const re = new RegExp(`\\b${escapeRegex(normalizedNeedle)}\\b`, 'g');
	const out: { line: number; snippet: string }[] = [];
	let cursor = 0;
	let lineNumber = 1;
	let m: RegExpExecArray | null;
	while (out.length < max && (m = re.exec(normalized)) !== null) {
		const hit = m.index;
		for (let i = cursor; i < hit; i++) {
			if (original.charCodeAt(i) === 0x0a) lineNumber++;
		}
		cursor = hit;
		const lineStart = original.lastIndexOf('\n', hit) + 1;
		const lineEnd = original.indexOf('\n', hit);
		const lineFullEnd = lineEnd < 0 ? original.length : lineEnd;
		const line = original.slice(lineStart, lineFullEnd).trim();
		const localHit = hit - lineStart;
		const snippetStart = Math.max(0, localHit - CONTENT_SNIPPET_PAD);
		const snippetEnd = Math.min(line.length, localHit + normalizedNeedle.length + CONTENT_SNIPPET_PAD);
		const snippet = line.slice(snippetStart, snippetEnd);
		out.push({
			line: lineNumber,
			snippet: snippetStart > 0 ? '…' + snippet : snippet,
		});
		if (re.lastIndex === hit) re.lastIndex++;
	}
	return out;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function bm25TermScore(tf: number, dl: number, avgdl: number, idf: number): number {
	if (tf === 0 || avgdl === 0) return 0;
	const numerator = tf * (BM25_K1 + 1);
	const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl);
	return idf * (numerator / denominator);
}

export function computeRrfScores(buckets: Map<string, FileBucket>): Map<string, number> {
	// One sorted list per (surface, fuzzy?) pair. Splitting exact and fuzzy
	// means an exact match always outranks a fuzzy match in the same surface
	// (separate lists, each ranked from #1), and fuzzy hits still contribute
	// real RRF weight when there's no exact match. ranks are 1-indexed.
	const surfaces: HitWhere[] = ['filename', 'alias', 'heading', 'tag', 'linkDisplayText', 'content'];
	const result = new Map<string, number>();
	for (const surface of surfaces) {
		for (const fuzzy of [false, true]) {
			if (fuzzy && surface === 'content') continue;
			if (fuzzy && surface === 'linkDisplayText') continue;
			const entries: { path: string; best: number }[] = [];
			for (const b of buckets.values()) {
				let best = -Infinity;
				for (const h of b.hits) {
					if (h.in !== surface) continue;
					if (!!h.fuzzy !== fuzzy) continue;
					if (h.score > best) best = h.score;
				}
				if (best > -Infinity) entries.push({ path: b.file.path, best });
			}
			entries.sort((a, b) => b.best - a.best);
			entries.forEach((e, i) => {
				const rank = i + 1;
				result.set(e.path, (result.get(e.path) ?? 0) + 1 / (RRF_K + rank));
			});
		}
	}
	return result;
}

export function emptyHint(args: {
	query: string;
	tag: string;
	pathPrefix: string;
	sinceDays: number | undefined;
	deepSearch: boolean;
}): string {
	const tips: string[] = [];
	if (args.query && !args.deepSearch) tips.push('set deepSearch=true to force a full-vault body scan');
	if (args.query) tips.push('try a single key word, or issue parallel calls with related terms (synonyms)');
	if (args.pathPrefix) tips.push('drop pathPrefix (folder may be empty or misspelled)');
	if (args.tag) tips.push("check tag spelling - case-insensitive, leading '#' optional, exact match");
	if (args.sinceDays !== undefined) tips.push('widen sinceDays or remove it');
	if (tips.length === 0) return '0 matches.';
	return `0 matches. Try: ${tips.join('; ')}.`;
}

function strArg(v: unknown): string {
	if (typeof v === 'string') return v.trim();
	return '';
}

export function stripEnclosingQuotes(s: string): string {
	if (s.length < 2) return s;
	const first = s[0];
	const last = s[s.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return s.slice(1, -1).trim();
	}
	return s;
}

function intArg(v: unknown): number | undefined {
	if (v === undefined || v === null || v === '') return undefined;
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function normalizeTag(raw: string): string {
	if (!raw) return '';
	const trimmed = raw.startsWith('#') ? raw : '#' + raw;
	return trimmed.toLowerCase();
}

/**
 * Strip leading and trailing slashes so the prefix represents a clean folder
 * (or file) segment. Empty string means "no filter".
 */
export function normalizePathPrefix(raw: string): string {
	return (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Match a vault path against a folder/file prefix on segment boundaries so
 * `Daily` matches `Daily/2026-05-20.md` but not `DailyNotes/...`. An exact
 * match (e.g. for a file path) also matches.
 */
export function matchesPathPrefix(path: string, prefix: string): boolean {
	if (!prefix) return true;
	if (path === prefix) return true;
	return path.startsWith(prefix + '/');
}

// Obsidian's vault-wide "Excluded files" list (Settings → Files and links →
// Excluded files). Not in obsidian.d.ts; lives at app.vault.config.userIgnoreFilters.
// Accepts four entry shapes:
//   "Archive"             — bare folder name, segment-prefix match
//   "Archive/"            — folder with trailing slash, same semantics
//   "Archive/**"          — recursive glob, same semantics
//   "/regex/"             — slash-wrapped JS regex against the full path
export function getUserIgnoreFilters(app: App): string[] {
	const raw: unknown = (app as unknown as { vault: { config?: { userIgnoreFilters?: unknown } } })
		.vault.config?.userIgnoreFilters;
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item === 'string' && item.length > 0) out.push(item);
	}
	return out;
}

export function matchesIgnoreFilter(filter: string, path: string): boolean {
	if (!filter) return false;
	if (filter.length >= 2 && filter.startsWith('/') && filter.endsWith('/')) {
		try {
			return new RegExp(filter.slice(1, -1)).test(path);
		} catch {
			return false;
		}
	}
	if (filter.endsWith('/**')) {
		const root = filter.slice(0, -3);
		return root ? matchesPathPrefix(path, root) : false;
	}
	if (filter.endsWith('/')) {
		const root = filter.slice(0, -1);
		return root ? matchesPathPrefix(path, root) : false;
	}
	return matchesPathPrefix(path, filter);
}

export function isUserIgnored(filters: string[], path: string): boolean {
	for (const f of filters) {
		if (matchesIgnoreFilter(f, path)) return true;
	}
	return false;
}

/**
 * Strip a leading `# <Filename>` heading if it exactly matches the basename of
 * the file path. Obsidian renders the filename as the page title (inline title);
 * a duplicate H1 in the body makes the title appear twice. Only triggers on
 * exact-match — leaves any other H1 alone.
 */
export function stripDuplicateTitleHeading(path: string, content: string): string {
	const basename = path.replace(/\.md$/i, '').split('/').pop() ?? '';
	if (!basename) return content;
	const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Optional frontmatter block, optional whitespace, then `# Basename` followed
	// by end-of-line or end-of-file (so `# FooBar` does NOT match basename `Foo`),
	// then optionally a blank line below.
	const pattern = new RegExp(
		`^((?:---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n)?\\s*)# ${escaped}[ \\t]*(?=\\r?\\n|$)(?:\\r?\\n){0,2}`,
	);
	return content.replace(pattern, '$1');
}

/**
 * Path allowlist used by both read and write/delete tools. Returns an error
 * message if blocked, or empty string if allowed. `metaDir` is normalized so
 * a trailing slash in user settings can't produce a `meta//chats/` prefix that
 * a vault-relative path would silently bypass.
 */
export function pathGuard(
	path: string,
	metaDir: string,
	opts: { requireMarkdown?: boolean } = {},
): string {
	if (path.startsWith('/') || path.includes('../') || path.includes('..\\')) {
		return 'absolute or parent-relative paths are forbidden';
	}
	if (path.startsWith('.obsidian/') || path === '.obsidian') return 'access to .obsidian/ is forbidden';
	const meta = normalizePath(metaDir || '').replace(/\/+$/, '');
	if (meta) {
		const internalPrefix = `${meta}/.smart-aide/`;
		const chatsPrefix = `${meta}/chats/`;
		if (path === `${meta}/.smart-aide` || path.startsWith(internalPrefix)) {
			return `access to ${internalPrefix} is forbidden (plugin internal)`;
		}
		if (path === `${meta}/chats` || path.startsWith(chatsPrefix)) {
			return `access to ${chatsPrefix} is forbidden (chat history is managed by the plugin)`;
		}
	}
	if (opts.requireMarkdown && !/\.md$/i.test(path)) {
		return 'only .md files are supported';
	}
	return '';
}

function compactHit(h: Hit): Record<string, unknown> {
	const out: Record<string, unknown> = { in: h.in, text: h.text };
	if (h.heading !== undefined) out.heading = h.heading;
	if (h.targetPath !== undefined) out.targetPath = h.targetPath;
	if (h.line !== undefined) out.line = h.line;
	if (h.startLine !== undefined) out.startLine = h.startLine;
	if (h.endLine !== undefined && h.endLine !== Number.MAX_SAFE_INTEGER) out.endLine = h.endLine;
	return out;
}
