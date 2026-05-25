import type { AgentMessage, Entry, MessageEntry, ToolCallBlock, ToolResultBlock } from './types';

/**
 * Tiny LCS-based line diff. Returns ops in display order.
 */
export function lineDiff(a: string[], b: string[]): { type: 'equal' | 'add' | 'remove'; line: string }[] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	const ops: { type: 'equal' | 'add' | 'remove'; line: string }[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
			ops.push({ type: 'equal', line: a[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.push({ type: 'add', line: b[j - 1] });
			j--;
		} else if (i > 0) {
			ops.push({ type: 'remove', line: a[i - 1] });
			i--;
		}
	}
	return ops.reverse();
}

export function safeParse(s: string): Record<string, unknown> {
	if (!s) return {};
	try {
		return JSON.parse(s);
	} catch {
		return { _raw: s };
	}
}

export function tryFormatJson(s: string): string {
	try {
		return JSON.stringify(JSON.parse(s), null, 2);
	} catch {
		return s;
	}
}

export function shouldShowRoleLabel(m: AgentMessage): boolean {
	if (m.role === 'user') return true;
	if (m.role === 'tool') return false;
	if (m.role === 'assistant') {
		if (typeof m.content === 'string') return m.content.trim().length > 0;
		return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
	}
	return true;
}

export function formatArgsInline(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	if (entries.length === 0) return '()';
	const parts = entries.map(([k, v]) => `${k}=${formatArgValue(v)}`);
	const joined = parts.join(', ');
	if (joined.length <= 80) return `(${joined})`;
	return `(${joined.slice(0, 77)}…)`;
}

function clip(s: string, max = 80): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + '…';
}

function quoted(s: string, max = 80): string {
	return `"${clip(s, max)}"`;
}

/**
 * Human-readable label for a tool call in the activity-card detail. Falls
 * back to the raw `name(args)` form for unknown tools. Used in place of the
 * technical signature so the expanded activity reads like a narration of what
 * the assistant did, not a function trace.
 */
export function humanizeToolCall(name: string, args: Record<string, unknown>): string {
	const path = typeof args.path === 'string' ? args.path.replace(/\.md$/, '') : '';
	const query = typeof args.query === 'string' ? args.query : '';
	const tag = typeof args.tag === 'string' ? args.tag : '';
	const section = typeof args.section === 'string' ? args.section : '';
	const startLine = typeof args.startLine === 'number' ? args.startLine : undefined;
	const endLine = typeof args.endLine === 'number' ? args.endLine : undefined;
	const skillName = typeof args.name === 'string' ? args.name : '';

	switch (name) {
		case 'search_vault': {
			const terms: string[] = [];
			if (query) terms.push(`for ${quoted(query, 60)}`);
			if (tag) terms.push(`tag #${tag.replace(/^#/, '')}`);
			const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
			if (pathPrefix) terms.push(`in ${pathPrefix}`);
			if (args.deepSearch === true) terms.push('(deep)');
			return terms.length ? `Searched vault ${terms.join(' ')}` : 'Searched vault';
		}
		case 'read_note': {
			if (!path) return 'Read note';
			if (section) return `Read ${quoted(path, 50)} — ${section}`;
			if (startLine !== undefined && endLine !== undefined) {
				return `Read ${quoted(path, 50)} (lines ${startLine}–${endLine})`;
			}
			if (startLine !== undefined) return `Read ${quoted(path, 50)} (from line ${startLine})`;
			return `Read ${quoted(path, 60)}`;
		}
		case 'list_recent': {
			const sinceDays = typeof args.sinceDays === 'number' ? args.sinceDays : undefined;
			if (sinceDays !== undefined) return `Listed notes from the last ${sinceDays} day${sinceDays === 1 ? '' : 's'}`;
			return 'Listed recent notes';
		}
		case 'get_backlinks':
			return path ? `Looked up backlinks to ${quoted(path, 60)}` : 'Looked up backlinks';
		case 'load_skill':
			return skillName ? `Loaded skill ${quoted(skillName, 40)}` : 'Loaded skill';
		case 'write_note':
			return path ? `Proposed write to ${quoted(path, 60)}` : 'Proposed write';
		case 'append_to_note':
			return path ? `Proposed append to ${quoted(path, 60)}` : 'Proposed append';
		case 'delete_note':
			return path ? `Proposed delete of ${quoted(path, 60)}` : 'Proposed delete';
		default:
			return `${name}${formatArgsInline(args)}`;
	}
}

export function formatArgValue(v: unknown): string {
	if (typeof v === 'string') return `"${v}"`;
	if (v === null || v === undefined) return String(v);
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return JSON.stringify(v);
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n} tok`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k tok`;
	return `${Math.round(n / 1000)}k tok`;
}

export type TokenChipSeverity = 'normal' | 'muted' | 'warn';

export interface TokenChipDisplay {
	pct: string | null;
	abs: string | null;
	severity: TokenChipSeverity;
}

/**
 * Visibility rules for the ambient token chip in the composer toolbar.
 * Percentage is hidden under 70% so an idle chat reads just "4.0k" — the
 * percent reappears (and the chip tints muted, then warn) as context fills.
 * Absolute count drops the " tok" suffix to keep the chip compact; tooltips
 * and popovers use formatTokens() for the longer form.
 */
export function formatTokenChip(total: number, contextLength: number | undefined | null): TokenChipDisplay {
	const pctValue = contextLength && contextLength > 0
		? Math.min(100, Math.round((total / contextLength) * 100))
		: null;
	const severity: TokenChipSeverity = pctValue === null
		? 'normal'
		: pctValue >= 90 ? 'warn' : pctValue >= 70 ? 'muted' : 'normal';
	const pct = pctValue !== null && pctValue >= 70 ? `${pctValue}%` : null;
	const abs = total > 0
		? total < 1000
			? `${total}`
			: total < 10000
				? `${(total / 1000).toFixed(1)}k`
				: `${Math.round(total / 1000)}k`
		: null;
	return { pct, abs, severity };
}

/** Rough token estimate: chars / 4. Cheap and consistent across the UI. */
export function estimateTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / 4);
}

/**
 * Per-entry contribution to the chain token total. `message` and
 * `custom_message` entries (skill loads, slash invocations) are sent to the
 * provider verbatim and carry tokens; model_change / session_info / custom
 * are metadata and carry zero. Constant per entry id (Pi entries are
 * immutable once persisted), so callers can memoize by id and skip
 * re-walking content on every rerender.
 */
export function estimateEntryTokens(e: Entry): number {
	if (e.type === 'custom_message') return estimateTokens(e.content);
	if (e.type !== 'message') return 0;
	const m = e.message;
	if (typeof m.content === 'string') return estimateTokens(m.content);
	let n = 0;
	for (const b of m.content) {
		if (b.type === 'text') n += estimateTokens(b.text);
		else if (b.type === 'toolCall') n += estimateTokens(JSON.stringify(b.arguments)) + 6;
		else if (b.type === 'toolResult') n += estimateTokens(b.content);
	}
	return n;
}

/**
 * Pre-send token projection broken down by source so the user can see *what's
 * costing them*: system + vault context + skills manifest are baseline overhead;
 * pinned + loaded skills + history + composer are what they actively control.
 */
export interface TokenBreakdown {
	base: number;
	vault: number;
	skillsManifest: number;
	pinned: number;
	skillsLoaded: number;
	history: number;
	composer: number;
}

export function sumBreakdown(b: TokenBreakdown): number {
	return b.base + b.vault + b.skillsManifest + b.pinned + b.skillsLoaded + b.history + b.composer;
}

export interface CumulativeUsage {
	prompt: number;
	completion: number;
	cached: number;
}

/**
 * Sum every `turn-usage` custom entry on the active branch into a cumulative
 * total. Used when (re)rendering a chat to reconstruct "Session so far" — the
 * live `onUsage` increments only cover turns streamed since the view opened,
 * but the persisted entries cover the full history.
 */
export function reduceCumulativeUsage(chain: Entry[]): CumulativeUsage {
	let prompt = 0;
	let completion = 0;
	let cached = 0;
	for (const entry of chain) {
		if (entry.type !== 'custom' || entry.customType !== 'turn-usage' || !entry.data) continue;
		const d = entry.data as { promptTokens?: unknown; completionTokens?: unknown; cachedTokens?: unknown };
		if (typeof d.promptTokens !== 'number' || typeof d.completionTokens !== 'number') continue;
		prompt += d.promptTokens;
		completion += d.completionTokens;
		if (typeof d.cachedTokens === 'number') cached += d.cachedTokens;
	}
	return { prompt, completion, cached };
}

/**
 * Project cost in USD given prompt + completion token estimates and a model's
 * per-million pricing. Returns null when no pricing is known so the caller can
 * fall back to token-only display. Sub-cent costs collapse to "<$0.01".
 */
export function formatCostUsd(
	promptTokens: number,
	completionTokens: number,
	meta: { promptPrice?: number; completionPrice?: number } | undefined,
): string | null {
	if (!meta || (meta.promptPrice === undefined && meta.completionPrice === undefined)) return null;
	const pp = meta.promptPrice ?? 0;
	const cp = meta.completionPrice ?? 0;
	const total = (pp * promptTokens + cp * completionTokens) / 1_000_000;
	if (total === 0) return '$0';
	if (total < 0.01) return '<$0.01';
	return `$${total.toFixed(2)}`;
}

export function messageText(m: AgentMessage, sep = ''): string {
	if (typeof m.content === 'string') return m.content;
	return m.content
		.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
		.map((b) => b.text)
		.join(sep);
}

export function extractToolCalls(entry: MessageEntry): ToolCallBlock[] {
	const m = entry.message;
	if (typeof m.content === 'string') return [];
	return m.content.filter((b): b is ToolCallBlock => b.type === 'toolCall');
}

export function extractToolResults(entry: MessageEntry): ToolResultBlock[] {
	const m = entry.message;
	if (typeof m.content === 'string') return [];
	return m.content.filter((b): b is ToolResultBlock => b.type === 'toolResult');
}

export function tryParseJSON(s: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(s);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function researchIcon(calls: ToolCallBlock[], invokedSkill: string | null = null): string {
	if (invokedSkill && calls.length === 0) return '🪄';
	const names = new Set(calls.map((c) => c.name));
	if (names.size === 1) {
		if (names.has('read_note')) return '📖';
		if (names.has('list_recent')) return '🕘';
		if (names.has('get_backlinks')) return '🔗';
		if (names.has('load_skill')) return '🧩';
		if (names.has('write_note') || names.has('append_to_note')) return '✎';
		if (names.has('delete_note')) return '🗑';
	}
	return '🔍';
}

export function buildResearchHeadline(
	calls: ToolCallBlock[],
	results: ToolResultBlock[],
	skillCount = 0,
	invokedSkill: string | null = null,
): string {
	const counts = new Map<string, number>();
	for (const c of calls) counts.set(c.name, (counts.get(c.name) || 0) + 1);

	const parts: string[] = [];
	if (invokedSkill) parts.push(`/${invokedSkill}`);
	for (const [name, count] of counts) parts.push(displayToolName(name, count));
	if (skillCount > 0) parts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'} loaded`);

	let totalHits = 0;
	let sawSearch = false;
	for (const r of results) {
		if (r.isError) continue;
		try {
			const p = JSON.parse(r.content);
			if (typeof p.matches === 'number') {
				sawSearch = true;
				totalHits += p.matches;
			}
		} catch {
			// ignore
		}
	}
	if (sawSearch) parts.push(`${totalHits} hit${totalHits === 1 ? '' : 's'}`);

	return parts.join(' · ');
}

export function displayToolName(name: string, count: number): string {
	const labels: Record<string, [string, string]> = {
		search_vault: ['search', 'searches'],
		read_note: ['read', 'reads'],
		list_recent: ['listing', 'listings'],
		get_backlinks: ['backlinks', 'backlinks'],
		load_skill: ['skill', 'skills'],
		write_note: ['write', 'writes'],
		append_to_note: ['append', 'appends'],
		delete_note: ['delete', 'deletes'],
	};
	const [sg, pl] = labels[name] ?? [name, name];
	return `${count} ${count === 1 ? sg : pl}`;
}

export function formatUsageTooltip(usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string {
	const parts: string[] = [];
	parts.push(`${formatTokens(usage.promptTokens)} in`);
	parts.push(`${formatTokens(usage.completionTokens)} out`);
	if (usage.cachedTokens && usage.cachedTokens > 0) {
		parts.push(`${formatTokens(usage.cachedTokens)} cached`);
	}
	return parts.join(' · ');
}

/**
 * One activity "burst" = a user message + every tool/skill action and the final
 * assistant answer that came in response. Used to collapse multi-turn tool runs
 * (search → search → read → answer) into a single "Researched · X" chip plus
 * the final text, so the chat reads at the cadence the user is thinking in.
 */
export interface BurstActivity {
	toolCalls: ToolCallBlock[];
	toolResults: ToolResultBlock[];
	loadedSkills: string[];
	/** Set when the user opened this burst with `/<name>` — one per burst by construction. */
	invokedSkill: string | null;
	/** Assistant message-entry IDs that contributed to the activity (for usage sum). */
	entryIds: string[];
}

export interface Burst {
	user: MessageEntry | null;
	activity: BurstActivity;
	final: MessageEntry | null;
}

export function groupChainIntoBursts(chain: Entry[]): Burst[] {
	const bursts: Burst[] = [];
	let current: Burst | null = null;
	// Invocation markers persist BEFORE the user message in the chain (so the
	// model sees the skill body as context for that user turn). Buffer the name
	// here and attach it to the next user message's burst.
	let pendingInvocation: string | null = null;

	const fresh = (user: MessageEntry | null): Burst => ({
		user,
		activity: { toolCalls: [], toolResults: [], loadedSkills: [], invokedSkill: null, entryIds: [] },
		final: null,
	});

	for (const entry of chain) {
		if (entry.type === 'message') {
			const m = entry.message;
			if (m.role === 'user') {
				if (current) bursts.push(current);
				current = fresh(entry);
				if (pendingInvocation) {
					current.activity.invokedSkill = pendingInvocation;
					pendingInvocation = null;
				}
			} else if (m.role === 'assistant') {
				if (!current) current = fresh(null);
				current.activity.entryIds.push(entry.id);
				const calls = extractToolCalls(entry);
				if (calls.length > 0) {
					current.activity.toolCalls.push(...calls);
					// Intra-turn narration (text alongside tool calls) is intentionally dropped —
					// the research chip carries the activity.
				} else {
					// Pure text — newest text-only message becomes the burst's final answer.
					current.final = entry;
				}
			} else if (m.role === 'tool') {
				if (!current) current = fresh(null);
				const results = extractToolResults(entry);
				current.activity.toolResults.push(...results);
			}
		} else if (entry.type === 'custom_message' && entry.customType === 'skill') {
			if (!current) current = fresh(null);
			const match = entry.display?.match(/skill:\s*(\S+)/);
			if (match) current.activity.loadedSkills.push(match[1]);
		} else if (entry.type === 'custom_message' && entry.customType === 'skill-invocation') {
			const name = entry.display?.trim();
			if (name) pendingInvocation = name;
		}
	}

	if (current) bursts.push(current);
	return bursts;
}

export interface SlashInvocation {
	name: string;
	rest: string;
}

/**
 * Parse a leading `/<name>` slash invocation from composer text.
 *
 * Returns null when:
 *   - the text doesn't start with `/<name>`
 *   - the name is not in the caller-provided allowlist (the user typed an
 *     unrelated slash, like a markdown path — we send the message verbatim).
 *
 * The name match is case-insensitive; the returned `name` is the lowercased
 * skill name. `rest` is the trimmed remainder after the name and one
 * whitespace separator.
 */
export function parseSlashInvocation(
	text: string,
	validSkillNames: string[],
): SlashInvocation | null {
	const match = text.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
	if (!match) return null;
	const name = match[1].toLowerCase();
	const allowed = new Set(validSkillNames.map((n) => n.toLowerCase()));
	if (!allowed.has(name)) return null;
	return { name, rest: (match[2] ?? '').trim() };
}

/**
 * Filter a tool list by an allowlist. Returns the input unchanged when
 * `allowed` is null (no restriction). An empty allowlist returns an empty
 * tool list — the model gets no tools for the turn.
 */
export function filterTools<T extends { name: string }>(
	tools: T[],
	allowed: string[] | null,
): T[] {
	if (allowed === null) return tools;
	const set = new Set(allowed);
	return tools.filter((t) => set.has(t.name));
}

/**
 * While the user is typing in the composer, return the in-progress slash query
 * (possibly empty) when the whole text matches `/<name>` with no terminator,
 * or null otherwise. Once the user types a space or any other character, the
 * slash is "settled" and the popover dismisses (send-time `parseSlashInvocation`
 * still handles the final invocation).
 */
export function parseSlashContext(text: string): string | null {
	const match = text.match(/^\/([a-z][a-z0-9-]*)?$/i);
	if (!match) return null;
	return (match[1] ?? '').toLowerCase();
}

/**
 * Filter user-invocable skills for the popover. Prefix matches first
 * (ranked alphabetically), then substring matches. Skill counts here are
 * small (typically <20), so a richer fuzzy is unnecessary; the substring
 * fallback catches "/note" → "meeting-notes" / "daily-note".
 */
export function filterSkillsForSlash<T extends { name: string }>(
	skills: T[],
	query: string,
	max: number,
): T[] {
	if (!query) return skills.slice(0, max);
	const q = query.toLowerCase();
	const prefix: T[] = [];
	const contains: T[] = [];
	for (const s of skills) {
		const n = s.name.toLowerCase();
		if (n.startsWith(q)) prefix.push(s);
		else if (n.includes(q)) contains.push(s);
	}
	return [...prefix, ...contains].slice(0, max);
}

export interface SkillRegistryLike {
	loadable(name: string): { name: string; body: string } | null | undefined;
	visibleOnThisPlatform(): { name: string }[];
}

/**
 * Skills currently loaded on the active branch — union of `load_skill` results
 * (`customType === 'skill'`, display = `skill: <name>`) and slash invocations
 * (`customType === 'skill-invocation'`, display = `<name>`). Used to short-
 * circuit duplicate `load_skill` calls so the same body isn't appended twice.
 */
export function loadedSkillNamesOnChain(chain: Entry[]): Set<string> {
	const names = new Set<string>();
	for (const e of chain) {
		if (e.type !== 'custom_message') continue;
		if (e.customType === 'skill') {
			const name = e.display?.replace(/^skill:\s*/i, '').trim();
			if (name) names.add(name);
		} else if (e.customType === 'skill-invocation') {
			const name = e.display?.trim();
			if (name) names.add(name);
		}
	}
	return names;
}

/**
 * Resolve a `load_skill` tool call. The skill body is pushed onto
 * `pendingSkillLoads` instead of persisted directly — the dispatch loop in
 * view.ts drains the queue AFTER the tool-result entry is appended so providers
 * see [assistant tool_call → tool result → user skill context]. Interleaving a
 * skill `custom_message` between the assistant tool_call and its tool result
 * violates the adjacency that OpenAI / Anthropic / Gemini require.
 *
 * If the skill is already loaded on this branch (either persisted on the
 * active chain or queued earlier in the same tool batch), short-circuit with
 * `already_loaded` so the body isn't appended a second time. The provider
 * already has the instructions in context — re-sending them inflates tokens
 * and can confuse the model with duplicate guidance.
 */
export function handleSkillLoadCall(
	args: Record<string, unknown>,
	skills: SkillRegistryLike,
	pendingSkillLoads: { name: string; body: string }[],
	alreadyLoaded: Set<string>,
): string {
	const skillName = String(args.name ?? '').trim();
	if (!skillName) return JSON.stringify({ error: 'name is required' });
	const skill = skills.loadable(skillName);
	if (!skill) {
		return JSON.stringify({
			error: `no skill named '${skillName}'`,
			available: skills.visibleOnThisPlatform().map((s) => s.name),
		});
	}
	if (alreadyLoaded.has(skill.name) || pendingSkillLoads.some((p) => p.name === skill.name)) {
		return JSON.stringify({ status: 'already_loaded', skill: skill.name });
	}
	pendingSkillLoads.push({ name: skill.name, body: skill.body });
	return JSON.stringify({ status: 'loaded', skill: skill.name });
}

export interface LongPressGate {
	pointerDown(): void;
	pointerEnd(): void;
	/** Returns true if onClick fired, false if the click was swallowed by a prior long-press. */
	click(): boolean;
}

/**
 * State machine that distinguishes a tap from a long-press and swallows the
 * synthesized click that follows a long-press on touch devices. Without this
 * the long-press handler (e.g., open rename) fires AND the click handler
 * (e.g., open picker) fires right after, stacking two actions on one gesture.
 */
export function createLongPressGate(opts: {
	holdMs: number;
	onClick: () => void;
	onLongPress: () => void;
}): LongPressGate {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let didLongPress = false;
	const cancel = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	return {
		pointerDown() {
			cancel();
			didLongPress = false;
			timer = setTimeout(() => {
				timer = undefined;
				didLongPress = true;
				opts.onLongPress();
			}, opts.holdMs);
		},
		pointerEnd() {
			cancel();
		},
		click() {
			if (didLongPress) {
				didLongPress = false;
				return false;
			}
			opts.onClick();
			return true;
		},
	};
}

export interface ScreenWakeLockSentinel {
	released: boolean;
	release(): Promise<void>;
	addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockNavigator {
	wakeLock?: { request(type: 'screen'): Promise<ScreenWakeLockSentinel> };
}

export interface VisibilitySource {
	readonly visibilityState: 'visible' | 'hidden' | 'prerender';
	addEventListener(type: 'visibilitychange', listener: () => void): void;
	removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface ScreenWakeLock {
	acquire(): Promise<void>;
	release(): Promise<void>;
	dispose(): void;
}

/**
 * Keeps the screen awake while the caller wants the lock held. iOS WKWebView
 * (Capacitor) auto-releases the sentinel whenever the page goes hidden, so we
 * listen for visibilitychange and re-request on the next 'visible' transition
 * as long as release() hasn't been called. A silent no-op when
 * navigator.wakeLock is unavailable (older iOS, unsupported webview).
 */
export function createScreenWakeLock(opts: {
	navigator: WakeLockNavigator;
	visibility: VisibilitySource;
	onError?: (err: unknown) => void;
}): ScreenWakeLock {
	let wanted = false;
	let sentinel: ScreenWakeLockSentinel | null = null;
	let pending: Promise<void> | null = null;

	const requestOnce = async () => {
		if (!opts.navigator.wakeLock) return;
		if (sentinel) return;
		if (pending) return pending;
		pending = (async () => {
			try {
				const s = await opts.navigator.wakeLock!.request('screen');
				if (!wanted) {
					await s.release().catch(() => {});
					return;
				}
				sentinel = s;
				s.addEventListener('release', () => {
					if (sentinel === s) sentinel = null;
				});
			} catch (err) {
				opts.onError?.(err);
			} finally {
				pending = null;
			}
		})();
		return pending;
	};

	const onVisibilityChange = () => {
		if (opts.visibility.visibilityState === 'hidden' && sentinel) {
			// iOS WKWebView auto-releases when hidden anyway; do it explicitly so
			// our state stays in sync regardless of whether the 'release' event fires.
			const held = sentinel;
			sentinel = null;
			void held.release().catch(() => {});
			return;
		}
		if (opts.visibility.visibilityState === 'visible' && wanted && !sentinel) {
			void requestOnce();
		}
	};
	opts.visibility.addEventListener('visibilitychange', onVisibilityChange);

	return {
		async acquire() {
			wanted = true;
			if (opts.visibility.visibilityState === 'visible') {
				await requestOnce();
			}
		},
		async release() {
			wanted = false;
			const held = sentinel;
			sentinel = null;
			if (held) {
				try {
					await held.release();
				} catch (err) {
					opts.onError?.(err);
				}
			}
		},
		dispose() {
			opts.visibility.removeEventListener('visibilitychange', onVisibilityChange);
			wanted = false;
			const held = sentinel;
			sentinel = null;
			if (held) void held.release().catch(() => {});
		},
	};
}

export function summarizeToolResult(content: string): string {
	try {
		const parsed = JSON.parse(content);
		if (parsed.error) {
			const msg = String(parsed.error);
			return `error: ${msg.length > 80 ? msg.slice(0, 77) + '…' : msg}`;
		}
		if (typeof parsed.matches === 'number') {
			const returned = parsed.returned ?? parsed.results?.length ?? parsed.matches;
			const suffix = parsed.deepSearch ? ' (deepSearch)' : '';
			return `${returned} match${returned === 1 ? '' : 'es'}${suffix}`;
		}
		if (parsed.path) {
			if (parsed.truncated) {
				return `truncated ${parsed.path} (${parsed.bytes ?? '?'}B, showing ${parsed.endLine ?? '?'} of ${parsed.totalLines ?? '?'} lines)`;
			}
			if (parsed.startLine !== undefined) {
				return `${parsed.path} lines ${parsed.startLine}-${parsed.endLine}`;
			}
			if (parsed.lines !== undefined) {
				return `${parsed.path} (${parsed.lines} lines)`;
			}
			return parsed.path;
		}
		return `${content.length}B`;
	} catch {
		return `${content.length}B`;
	}
}
