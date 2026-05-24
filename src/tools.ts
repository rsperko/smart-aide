import { App, TFile, getAllTags, normalizePath, prepareFuzzySearch, prepareSimpleSearch } from 'obsidian';
import type { ToolDescriptor } from './providers/types';
import { ApprovalPreview, Tool, ToolContext } from './types';

const DEFAULT_MAX_RESULTS = 10;
const DEEP_MAX_RESULTS = 25;
const HARD_MAX_RESULTS = 50;
const MAX_HITS_PER_FILE = 3;
const CONTENT_SNIPPET_PAD = 40;
const MAX_CONTENT_MATCHES_PER_FILE = 2;

// BM25 tuning constants. k1 controls term-frequency saturation (1.2–2.0 is
// standard); b controls length normalization (0.75 is the textbook default).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// RRF constant. 60 is the value used by OpenSearch / Elasticsearch / Azure
// Search; the algorithm is famously tuning-free, so changing it is unlikely
// to help unless the surface count grows much larger.
const RRF_K = 60;

type HitWhere = 'filename' | 'heading' | 'tag' | 'content';
const TIER_PRIORITY: Record<HitWhere, number> = { filename: 4, heading: 3, tag: 2, content: 1 };

interface Hit {
	in: HitWhere;
	text: string;
	score: number;
	line?: number;
	startLine?: number;
	endLine?: number;
}

interface FileBucket {
	file: TFile;
	hits: Hit[];
}

const searchVault: Tool = {
	risk: 'read',
	name: 'search_vault',
	description: `Find notes. Set ≥1 of: query, tag, pathPrefix, sinceDays (AND'd).

query word-matches filename + headings + tags (fast, in-memory) — all space-separated words must appear (case-insensitive substring). Set deepSearch=true to also scan note bodies (substring match for the exact phrase) — use when default returns 0 hits or user says "search inside notes".

If nothing matches, a fuzzy character-order pass runs automatically (catches typos / abbreviations / partial recall). Response sets fuzzyFallback=true when this fired — treat those hits as approximate.

Use the user's exact remembered phrase, not paraphrase.

Examples:
- "find weekly review notes" → query="weekly review"
- "where I wrote 'eventual consistency'" → query="eventual consistency"
- "tagged book" → tag="book"
- "in my Daily folder" → pathPrefix="Daily"
- "task notes about onboarding" → tag="task", query="onboarding"
- "recent deadline notes" → query="deadline", sinceDays=30
- "any mention of Postgres" → query="Postgres", deepSearch=true

For vague concepts, fire parallel calls with synonyms — "find that piece on deep work" → 3 parallel calls (query="deep work", "deepwork", "flow"). Cheap.

Heading hits include startLine + endLine — pass to read_note for just that section. Read the hint field when matches=0.`,
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: "Fuzzy match phrase. User's exact words.",
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
				description: "Also scan note bodies (slower). Default false. Set true when default returns 0.",
			},
			maxResults: {
				type: 'integer',
				description: `Default ${DEFAULT_MAX_RESULTS}, cap ${HARD_MAX_RESULTS}.`,
			},
		},
	},
	async execute(args, ctx) {
		const query = stripEnclosingQuotes(strArg(args.query));
		const tag = normalizeTag(strArg(args.tag));
		const pathPrefix = strArg(args.pathPrefix);
		const sinceDays = intArg(args.sinceDays);
		const deepSearch = !!args.deepSearch;
		const defaultMax = deepSearch ? DEEP_MAX_RESULTS : DEFAULT_MAX_RESULTS;
		const maxResults = clamp(intArg(args.maxResults) ?? defaultMax, 1, HARD_MAX_RESULTS);

		if (!query && !tag && !pathPrefix && sinceDays === undefined) {
			return JSON.stringify({
				error: 'Provide at least one of: query, tag, pathPrefix, sinceDays.',
			});
		}

		const sinceMs = sinceDays !== undefined ? Date.now() - sinceDays * 86_400_000 : 0;

		let files = ctx.app.vault.getMarkdownFiles();
		if (pathPrefix) {
			const prefix = normalizePathPrefix(pathPrefix);
			files = files.filter((f) => matchesPathPrefix(f.path, prefix));
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
			const search = prepareSimpleSearch(query);

			// Pass 1: filenames
			for (const file of files) {
				const r = search(file.basename);
				if (r) record(file, { in: 'filename', text: file.basename, score: r.score });
			}

			// Pass 2 + 3: headings and tags via MetadataCache
			for (const file of files) {
				const cache = ctx.app.metadataCache.getFileCache(file);
				if (!cache) continue;

				const headings = cache.headings ?? [];
				for (let i = 0; i < headings.length; i++) {
					const h = headings[i];
					const r = search(h.heading);
					if (!r) continue;
					const startLine = h.position.start.line + 1;
					const endLine = sectionEndLine(
						headings,
						i,
						file.stat.size > 0 ? Number.MAX_SAFE_INTEGER : h.position.start.line + 1,
					);
					record(file, {
						in: 'heading',
						text: h.heading,
						score: r.score,
						startLine,
						endLine,
					});
				}

				const tagSet = new Set<string>();
				for (const t of cache.tags ?? []) tagSet.add(t.tag);
				const fm = cache.frontmatter?.tags;
				if (Array.isArray(fm)) for (const t of fm) tagSet.add('#' + String(t));
				else if (typeof fm === 'string') for (const t of fm.split(/[,\s]+/)) if (t) tagSet.add('#' + t);
				for (const t of tagSet) {
					const r = search(t);
					if (r) record(file, { in: 'tag', text: t, score: r.score });
				}
			}

			// Pass 4: content substring (opt-in), scored with inline BM25 across
			// query tokens. BM25 = TF saturation × inverse-document-frequency ×
			// length normalization — the industry-standard keyword relevance
			// formula. We compute it per-query on the candidate set, so no
			// persistent index is needed (mobile-safe).
			if (deepSearch) {
				const lowerQuery = query.toLowerCase();
				const queryTokens = tokenize(query);
				interface ContentCandidate {
					file: TFile;
					dl: number;
					tf: number[];
					matches: { line: number; snippet: string }[];
				}
				const candidates: ContentCandidate[] = [];
				for (const file of files) {
					if (buckets.has(file.path)) continue;
					const content = await ctx.app.vault.cachedRead(file);
					const lower = content.toLowerCase();
					const tf = queryTokens.map((t) => countOccurrences(lower, t));
					if (!tf.some((c) => c > 0)) continue;
					let matches = findContentMatches(content, lowerQuery, MAX_CONTENT_MATCHES_PER_FILE);
					if (matches.length === 0) {
						// Phrase not adjacent — snippet around the first present token instead.
						for (let i = 0; i < queryTokens.length; i++) {
							if (tf[i] > 0) {
								matches = findContentMatches(content, queryTokens[i], MAX_CONTENT_MATCHES_PER_FILE);
								break;
							}
						}
					}
					const dl = Math.max(1, lower.split(/\s+/).length);
					candidates.push({ file, dl, tf, matches });
				}
				if (candidates.length > 0) {
					const N = candidates.length;
					const avgdl = candidates.reduce((s, c) => s + c.dl, 0) / N;
					const idf = queryTokens.map((_, ti) => {
						const df = candidates.reduce((s, c) => s + (c.tf[ti] > 0 ? 1 : 0), 0);
						return Math.log((N - df + 0.5) / (df + 0.5) + 1);
					});
					for (const c of candidates) {
						let score = 0;
						for (let ti = 0; ti < queryTokens.length; ti++) {
							score += bm25TermScore(c.tf[ti], c.dl, avgdl, idf[ti]);
						}
						for (const m of c.matches) {
							record(c.file, {
								in: 'content',
								text: m.snippet,
								line: m.line,
								score,
							});
						}
					}
				}
			}

			// Fuzzy fallback: only fires when nothing matched. Catches typos
			// (imrov→improv), abbreviations (iom→Improv Openings Mid), and
			// partial recall (weekrev→weekly review).
			if (buckets.size === 0) {
				const fuzzy = prepareFuzzySearch(query);
				for (const file of files) {
					const r = fuzzy(file.basename);
					if (r) record(file, { in: 'filename', text: file.basename, score: r.score });
				}
				for (const file of files) {
					const cache = ctx.app.metadataCache.getFileCache(file);
					if (!cache) continue;
					const headings = cache.headings ?? [];
					for (let i = 0; i < headings.length; i++) {
						const h = headings[i];
						const r = fuzzy(h.heading);
						if (!r) continue;
						const startLine = h.position.start.line + 1;
						const endLine = sectionEndLine(
							headings,
							i,
							file.stat.size > 0 ? Number.MAX_SAFE_INTEGER : h.position.start.line + 1,
						);
						record(file, {
							in: 'heading',
							text: h.heading,
							score: r.score,
							startLine,
							endLine,
						});
					}
					const tagSet = new Set<string>();
					for (const t of cache.tags ?? []) tagSet.add(t.tag);
					const fm = cache.frontmatter?.tags;
					if (Array.isArray(fm)) for (const t of fm) tagSet.add('#' + String(t));
					else if (typeof fm === 'string') for (const t of fm.split(/[,\s]+/)) if (t) tagSet.add('#' + t);
					for (const t of tagSet) {
						const r = fuzzy(t);
						if (r) record(file, { in: 'tag', text: t, score: r.score });
					}
				}
				if (buckets.size > 0) fuzzyFallback = true;
			}
		} else {
			// No query - just filter-based listing
			for (const file of files) {
				record(file, { in: 'filename', text: file.basename, score: 0 });
			}
		}

		// Reciprocal Rank Fusion across the four surfaces. Each surface produces
		// a ranked list; files that appear strongly across multiple surfaces
		// (filename + content, etc.) beat files that only appear in one.
		// No score normalization needed — RRF is famously tuning-free.
		const rrfScores = computeRrfScores(buckets);
		const ranked = [...buckets.values()].sort((a, b) => {
			const aScore = rrfScores.get(a.file.path) ?? 0;
			const bScore = rrfScores.get(b.file.path) ?? 0;
			if (bScore !== aScore) return bScore - aScore;
			return b.file.stat.mtime - a.file.stat.mtime;
		});

		const sliced = ranked.slice(0, maxResults);
		const results = sliced.map((b) => ({
			path: b.file.path,
			mtime: isoDate(b.file.stat.mtime),
			hits: b.hits
				.sort((a, h) => TIER_PRIORITY[h.in] - TIER_PRIORITY[a.in] || h.score - a.score)
				.slice(0, MAX_HITS_PER_FILE)
				.map(compactHit),
		}));

		const response: Record<string, unknown> = {
			matches: ranked.length,
			returned: results.length,
			deepSearch,
			results,
		};
		if (fuzzyFallback) response.fuzzyFallback = true;
		if (ranked.length === 0) {
			response.hint = emptyHint({ query, tag, pathPrefix, sinceDays, deepSearch });
		} else if (ranked.length > maxResults) {
			response.hint = `Showing top ${maxResults} of ${ranked.length}. Narrow with pathPrefix, tag, or sinceDays.`;
		}
		return JSON.stringify(response);
	},
};

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
		if (pathPrefix) {
			const prefix = normalizePathPrefix(pathPrefix);
			files = files.filter((f) => matchesPathPrefix(f.path, prefix));
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
		const backlinks: { path: string; count: number }[] = [];
		for (const [source, targets] of Object.entries(links)) {
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

export function tokenize(s: string): string[] {
	return s.toLowerCase().split(/\s+/).filter(Boolean);
}

export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while (true) {
		const found = haystack.indexOf(needle, idx);
		if (found < 0) return count;
		count++;
		idx = found + needle.length;
	}
}

export function bm25TermScore(tf: number, dl: number, avgdl: number, idf: number): number {
	if (tf === 0 || avgdl === 0) return 0;
	const numerator = tf * (BM25_K1 + 1);
	const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl);
	return idf * (numerator / denominator);
}

export function computeRrfScores(buckets: Map<string, FileBucket>): Map<string, number> {
	// One sorted list per surface; ranks are 1-indexed.
	const surfaces: HitWhere[] = ['filename', 'heading', 'tag', 'content'];
	const result = new Map<string, number>();
	for (const surface of surfaces) {
		const entries: { path: string; best: number }[] = [];
		for (const b of buckets.values()) {
			let best = -Infinity;
			for (const h of b.hits) if (h.in === surface && h.score > best) best = h.score;
			if (best > -Infinity) entries.push({ path: b.file.path, best });
		}
		entries.sort((a, b) => b.best - a.best);
		entries.forEach((e, i) => {
			const rank = i + 1;
			result.set(e.path, (result.get(e.path) ?? 0) + 1 / (RRF_K + rank));
		});
	}
	return result;
}

export function findContentMatches(
	content: string,
	query: string,
	max: number,
): { line: number; snippet: string }[] {
	const lower = content.toLowerCase();
	const out: { line: number; snippet: string }[] = [];
	let idx = 0;
	while (out.length < max) {
		const hit = lower.indexOf(query, idx);
		if (hit < 0) break;
		const lineStart = lower.lastIndexOf('\n', hit) + 1;
		const lineEnd = lower.indexOf('\n', hit);
		const lineFullEnd = lineEnd < 0 ? content.length : lineEnd;
		const line = content.slice(lineStart, lineFullEnd).trim();
		const lineNumber = content.slice(0, lineStart).split('\n').length;
		const localHit = hit - lineStart;
		const snippetStart = Math.max(0, localHit - CONTENT_SNIPPET_PAD);
		const snippetEnd = Math.min(line.length, localHit + query.length + CONTENT_SNIPPET_PAD);
		const snippet = line.slice(snippetStart, snippetEnd);
		out.push({
			line: lineNumber,
			snippet: snippetStart > 0 ? '…' + snippet : snippet,
		});
		idx = lineFullEnd + 1;
	}
	return out;
}

export function emptyHint(args: {
	query: string;
	tag: string;
	pathPrefix: string;
	sinceDays: number | undefined;
	deepSearch: boolean;
}): string {
	const tips: string[] = [];
	if (args.query && !args.deepSearch) tips.push('set deepSearch=true to also scan note content');
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
	if (h.line !== undefined) out.line = h.line;
	if (h.startLine !== undefined) out.startLine = h.startLine;
	if (h.endLine !== undefined && h.endLine !== Number.MAX_SAFE_INTEGER) out.endLine = h.endLine;
	return out;
}
