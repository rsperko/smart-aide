import { App, TFile, getAllTags, normalizePath, prepareFuzzySearch } from 'obsidian';
import { ApprovalPreview, OpenAIToolDef, Tool, ToolContext } from './types';

const DEFAULT_MAX_RESULTS = 10;
const HARD_MAX_RESULTS = 50;
const MAX_HITS_PER_FILE = 3;
const CONTENT_SNIPPET_PAD = 40;
const MAX_CONTENT_MATCHES_PER_FILE = 2;

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
	bestTier: number;
	bestScore: number;
}

const searchVault: Tool = {
	risk: 'read',
	name: 'search_vault',
	description: `Find notes in the vault. Use whenever the user wants to locate notes by content, tag, folder, or recency.

Set AT LEAST ONE of: query, tag, pathPrefix, sinceDays. Combining them ANDs the criteria.

WHAT query MATCHES:
The query parameter fuzzy-matches against four surfaces in order of signal strength:
  1. filename - best signal; user often remembers the topic in the title
  2. heading  - finds specific sections inside longer notes (returns startLine + endLine for the section)
  3. tag      - the concept may be a tag name like #book
  4. content  - only if deepSearch=true; substring scan of note bodies (slower)

By default ONLY filename + heading + tag are scanned. This is fast on mobile (all in-memory). Set deepSearch=true to also scan note content - use this when the cheap passes returned 0 results.

Word order, case, and punctuation are ignored: query "weekly review" matches a file named "Weekly Reviews" or a heading "Weekly-review template".

EXAMPLES (map the user's intent to a call):
- "find that piece on weekly reviews" -> query="weekly review"
- "the note where I wrote 'eventual consistency'" -> query="eventual consistency"
- "find notes tagged book" -> tag="book"
- "what's in my Daily folder" -> pathPrefix="Daily"
- "find task notes about onboarding" -> tag="task", query="onboarding"
- "recent notes about deadlines" -> query="deadline", sinceDays=30
- "any mention of Postgres anywhere" -> query="Postgres", deepSearch=true

VAGUE CONCEPT QUERIES (user describes an idea, not a remembered phrase):
Consider issuing MULTIPLE search_vault calls in parallel with related terms.
E.g., "find that piece on deep work" -> three parallel calls:
  search_vault({query: "deep work"})
  search_vault({query: "deepwork"})
  search_vault({query: "flow"})
Then synthesize the merged results. Parallel calls are cheap (default mode is in-memory only).

EXACT REMEMBERED PHRASES:
Use the user's exact words, not paraphrase:
- "the note where I wrote 'eventual consistency'" -> query="eventual consistency" (NOT "where I wrote eventual consistency")
- "find that recipe with miso paste" -> query="miso paste" (NOT "recipe with miso paste")

FOLLOWING UP ON RESULTS:
Each result has a 'hits' array describing where the match landed. For heading hits,
use read_note(path, startLine, endLine) to fetch just that section. For filename hits,
use read_note(path) for the full file.

If results come back empty, read the 'hint' field and adjust. Results sort by tier (filename > heading > tag > content) then by mtime within tier.`,
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description:
					"Phrase or concept to fuzzy-match. Word order, case, and punctuation ignored. " +
					"Use the user's exact remembered words; don't add filler.",
			},
			tag: {
				type: 'string',
				description:
					"Exact tag filter, with or without leading #. " +
					"Matches inline #tags and frontmatter tags. NOT fuzzy - 'task' does NOT match 'tasks' or 'task/done'. " +
					"For fuzzy tag-name matching, use query instead.",
			},
			pathPrefix: {
				type: 'string',
				description: "Folder path to limit results, e.g. 'Daily' or 'Projects/Q4'.",
			},
			sinceDays: {
				type: 'integer',
				description:
					"Limit to notes modified within this many days. Use for 'recent' / 'last week' / 'this month'.",
			},
			deepSearch: {
				type: 'boolean',
				description:
					"When true, also substring-scan note content (slower, reads files). " +
					"Default false - only filename + heading + tag fuzzy match. " +
					"Set true when default search returns 0 results or user says 'search inside notes'.",
			},
			maxResults: {
				type: 'integer',
				description: `Default ${DEFAULT_MAX_RESULTS}, hard cap ${HARD_MAX_RESULTS}.`,
			},
		},
	},
	async execute(args, ctx) {
		const query = strArg(args.query);
		const tag = normalizeTag(strArg(args.tag));
		const pathPrefix = strArg(args.pathPrefix);
		const sinceDays = intArg(args.sinceDays);
		const deepSearch = !!args.deepSearch;
		const maxResults = clamp(intArg(args.maxResults) ?? DEFAULT_MAX_RESULTS, 1, HARD_MAX_RESULTS);

		if (!query && !tag && !pathPrefix && sinceDays === undefined) {
			return JSON.stringify({
				error: 'Provide at least one of: query, tag, pathPrefix, sinceDays.',
			});
		}

		const sinceMs = sinceDays !== undefined ? Date.now() - sinceDays * 86_400_000 : 0;

		let files = ctx.app.vault.getMarkdownFiles();
		if (pathPrefix) files = files.filter((f) => f.path.startsWith(pathPrefix));
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

		const record = (file: TFile, hit: Hit) => {
			let b = buckets.get(file.path);
			if (!b) {
				b = { file, hits: [], bestTier: 0, bestScore: -Infinity };
				buckets.set(file.path, b);
			}
			b.hits.push(hit);
			const tier = TIER_PRIORITY[hit.in];
			if (tier > b.bestTier || (tier === b.bestTier && hit.score > b.bestScore)) {
				b.bestTier = tier;
				b.bestScore = hit.score;
			}
		};

		if (query) {
			const fuzzy = prepareFuzzySearch(query);

			// Pass 1: filenames
			for (const file of files) {
				const r = fuzzy(file.basename);
				if (r) record(file, { in: 'filename', text: file.basename, score: r.score });
			}

			// Pass 2 + 3: headings and tags via MetadataCache
			for (const file of files) {
				const cache = ctx.app.metadataCache.getFileCache(file);
				if (!cache) continue;

				const headings = cache.headings ?? [];
				for (let i = 0; i < headings.length; i++) {
					const h = headings[i];
					const r = fuzzy(h.heading);
					if (!r) continue;
					const startLine = h.position.start.line + 1;
					const endLine = sectionEndLine(headings, i, file);
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

			// Pass 4: content substring (opt-in)
			if (deepSearch) {
				const lowerQuery = query.toLowerCase();
				for (const file of files) {
					if (buckets.has(file.path)) continue;
					const content = await ctx.app.vault.cachedRead(file);
					const matches = findContentMatches(content, lowerQuery, MAX_CONTENT_MATCHES_PER_FILE);
					for (const m of matches) {
						record(file, {
							in: 'content',
							text: m.snippet,
							line: m.line,
							score: 0,
						});
					}
				}
			}
		} else {
			// No query - just filter-based listing
			for (const file of files) {
				record(file, { in: 'filename', text: file.basename, score: 0 });
			}
		}

		const ranked = [...buckets.values()].sort((a, b) => {
			if (b.bestTier !== a.bestTier) return b.bestTier - a.bestTier;
			if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
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
	description: `Read note content. Three primary modes:

1. Full file: read_note({path}).
   For files larger than ${Math.round(AUTO_TRUNCATE_BYTES / 1000)}KB this auto-truncates to the first ~${Math.round(TRUNCATED_RETURN_BYTES / 1000)}KB plus an outline of headings. The response sets truncated=true and a hint tells you how to continue (use startLine= or section=).

2. Line range: read_note({path, startLine, endLine}).
   1-indexed, inclusive. Use the startLine + endLine from a search_vault heading hit to read just that section. No auto-truncation when a range is given.

3. Section by heading name: read_note({path, section: "Setup"}).
   Case-insensitive match against headings; tries exact match first, then fuzzy. Returns the section under it until the next same-or-higher heading. If no heading matches, the response lists available headings so you can retry.

EXAMPLES:
- "show me the Setup section" -> read_note({path, section: "Setup"})
- search_vault returned hit with startLine:23, endLine:41 -> read_note({path, startLine: 23, endLine: 41})
- "summarize this note" -> read_note({path}) — auto-truncates if huge
- "read more of [previously-truncated note]" -> read_note({path, startLine: <continueAt from prior response>})

Response always includes path and mtime. Range/section modes also include startLine + endLine + totalLines. Truncated responses include outline (heading list with line numbers) + truncated: true + a hint.`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative path including .md extension.' },
			startLine: {
				type: 'integer',
				description: '1-indexed first line to return (inclusive).',
			},
			endLine: {
				type: 'integer',
				description: '1-indexed last line to return (inclusive). Default: end of file.',
			},
			section: {
				type: 'string',
				description:
					"Heading name to fetch. Exact match first (case-insensitive), then fuzzy fallback. " +
					"Returns the section under that heading until the next same-or-higher heading. " +
					"Ignored if startLine/endLine is given.",
			},
		},
		required: ['path'],
	},
	async execute(args, ctx) {
		const rawPath = strArg(args.path);
		if (!rawPath) return JSON.stringify({ error: 'path is required' });
		const path = normalizePath(rawPath);
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
			const endLine = sectionEndLineByTotal(headings, matchIdx, totalLines);
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
	description: `Create or overwrite a vault note. REQUIRES USER APPROVAL — a diff is shown before any change.

Use for creating a new note OR replacing the full contents of an existing one. For appending to the end without touching existing content, prefer append_to_note (lower friction; smaller diff).

EXAMPLES:
- "create a note at Daily/2026-05-21.md with [...]" -> write_note(path, content)
- "rewrite this section to be clearer" -> read_note first, modify, write_note with full new content

Never writes outside the vault, never touches .obsidian/, never touches the active chat's own JSONL.`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative path including .md extension.' },
			content: { type: 'string', description: 'Full new content of the note.' },
		},
		required: ['path', 'content'],
	},
	async preview(args, ctx): Promise<ApprovalPreview> {
		const path = normalizePath(strArg(args.path));
		const file = ctx.app.vault.getFileByPath(path);
		const oldContent = file ? await ctx.app.vault.read(file) : '';
		const newContent = strArg(args.content);
		return {
			summary: file ? `Overwrite ${path}` : `Create ${path}`,
			diff: { kind: 'overwrite', path, oldContent, newContent },
		};
	},
	async execute(args, ctx) {
		const path = normalizePath(strArg(args.path));
		if (!path) return JSON.stringify({ error: 'path is required' });
		const guard = pathGuard(path);
		if (guard) return JSON.stringify({ error: guard });
		const content = strArg(args.content);
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
	description: `Append text to the end of an existing note. REQUIRES USER APPROVAL — the appended content is shown before any change.

Lower friction than write_note when only adding content. The note must exist; use write_note to create.

EXAMPLES:
- "add a TODO at the end of today's daily note" -> append_to_note(path, content)
- "log this insight in my journal" -> append_to_note(journal-path, content)`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative path including .md extension.' },
			content: { type: 'string', description: 'Text to append. Include leading newlines if you want a blank line before.' },
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
		const guard = pathGuard(path);
		if (guard) return JSON.stringify({ error: guard });
		const file = ctx.app.vault.getFileByPath(path);
		if (!file) return JSON.stringify({ error: `not found: ${path}` });
		await ctx.app.vault.append(file, strArg(args.content));
		return JSON.stringify({ status: 'appended', path });
	},
};

const deleteNote: Tool = {
	risk: 'delete',
	name: 'delete_note',
	description: `Move a note to trash. REQUIRES USER CONFIRMATION — the path is shown before any change. Uses Obsidian's trash setting (system trash or local .trash).

Only use when the user explicitly asks to delete. Don't use to "tidy up" or "clean" automatically.`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative path including .md extension.' },
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
		const guard = pathGuard(path);
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
	description: `List the most-recently-modified notes in the vault or a folder. Use for "what did I write recently", "show today's daily notes", "recent journal entries".

Returns path + mtime, sorted newest first.`,
	parameters: {
		type: 'object',
		properties: {
			pathPrefix: { type: 'string', description: "Optional folder to limit to (e.g., 'Daily', 'Journal')." },
			limit: { type: 'integer', description: 'Default 10, hard cap 50.' },
		},
	},
	async execute(args, ctx) {
		const pathPrefix = strArg(args.pathPrefix);
		const limit = clamp(intArg(args.limit) ?? 10, 1, 50);
		let files = ctx.app.vault.getMarkdownFiles();
		if (pathPrefix) files = files.filter((f) => f.path.startsWith(pathPrefix));
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
	description: `List notes that link TO a given note. Use for "what links to this", "what references X", "where is this discussed".

Uses MetadataCache resolvedLinks — fast, no file reads. Returns paths sorted by link count (notes that link most often first).`,
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative path of the target note.' },
		},
		required: ['path'],
	},
	async execute(args, ctx) {
		const target = normalizePath(strArg(args.path));
		if (!target) return JSON.stringify({ error: 'path is required' });
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

const loadSkill: Tool = {
	risk: 'read',
	name: 'load_skill',
	description: `Load a skill's full body into context by name. Skill descriptions are visible to you at all times in the system prompt; call this to pull a specific skill's full content when you judge it relevant to the user's request.

EXAMPLES:
- User asks for a daily log template and you see a skill named 'daily-log' -> load_skill('daily-log')
- User asks to write a meeting recap and 'meeting-notes' skill is available -> load_skill('meeting-notes')

The loaded body becomes part of the conversation and will guide subsequent responses.`,
	parameters: {
		type: 'object',
		properties: {
			name: { type: 'string', description: "Skill name as listed in the system prompt's skill manifest." },
		},
		required: ['name'],
	},
	async execute(args, ctx) {
		// Implementation is supplied by the view at dispatch time (it has the registry).
		// The default implementation here returns an error so misuse is visible.
		return JSON.stringify({ error: 'load_skill must be dispatched through the view' });
	},
};

export const TOOLS: Tool[] = [searchVault, readNote, writeNote, appendToNote, deleteNote, listRecent, getBacklinks, loadSkill];

export const LOAD_SKILL_NAME = 'load_skill';

export function toolsToOpenAI(tools: Tool[]): OpenAIToolDef[] {
	return tools.map((t) => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}

export async function dispatchTool(
	tools: Tool[],
	name: string,
	args: Record<string, unknown>,
	app: App,
): Promise<string> {
	const tool = tools.find((t) => t.name === name);
	if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` });
	try {
		return await tool.execute(args, { app });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return JSON.stringify({ error: `tool ${name} failed: ${msg}` });
	}
}

function sectionEndLine(
	headings: { heading: string; level: number; position: { start: { line: number } } }[],
	index: number,
	file: TFile,
): number {
	const here = headings[index];
	for (let j = index + 1; j < headings.length; j++) {
		if (headings[j].level <= here.level) {
			return headings[j].position.start.line;
		}
	}
	return file.stat.size > 0 ? Number.MAX_SAFE_INTEGER : here.position.start.line + 1;
}

function sectionEndLineByTotal(
	headings: { heading: string; level: number; position: { start: { line: number } } }[],
	index: number,
	totalLines: number,
): number {
	const here = headings[index];
	for (let j = index + 1; j < headings.length; j++) {
		if (headings[j].level <= here.level) {
			return headings[j].position.start.line;
		}
	}
	return totalLines;
}

function findSectionIndex(
	headings: { heading: string }[],
	section: string,
): number {
	const targetLower = section.toLowerCase();
	const exactIdx = headings.findIndex((h) => h.heading.toLowerCase() === targetLower);
	if (exactIdx >= 0) return exactIdx;
	const fuzzy = prepareFuzzySearch(section);
	let bestScore = -Infinity;
	let bestIdx = -1;
	for (let i = 0; i < headings.length; i++) {
		const r = fuzzy(headings[i].heading);
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

function findContentMatches(
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

function emptyHint(args: {
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

function normalizeTag(raw: string): string {
	if (!raw) return '';
	const trimmed = raw.startsWith('#') ? raw : '#' + raw;
	return trimmed.toLowerCase();
}

/**
 * Path allowlist for write/delete operations. Returns an error message if blocked,
 * or empty string if allowed.
 */
function pathGuard(path: string): string {
	if (path.startsWith('.obsidian/') || path === '.obsidian') return 'writes to .obsidian/ are forbidden';
	if (path.startsWith('sys/.smart-aide/')) return 'writes to sys/.smart-aide/ are forbidden (plugin internal)';
	if (path.startsWith('sys/chats/')) return 'writes to sys/chats/ are forbidden (chat history is managed by the plugin)';
	if (path.startsWith('/') || path.includes('../') || path.includes('..\\')) return 'absolute or parent-relative paths are forbidden';
	return '';
}

function compactHit(h: Hit): Record<string, unknown> {
	const out: Record<string, unknown> = { in: h.in, text: h.text };
	if (h.line !== undefined) out.line = h.line;
	if (h.startLine !== undefined) out.startLine = h.startLine;
	if (h.endLine !== undefined && h.endLine !== Number.MAX_SAFE_INTEGER) out.endLine = h.endLine;
	return out;
}
