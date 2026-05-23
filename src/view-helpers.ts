import type { AgentMessage, MessageEntry, ToolCallBlock, ToolResultBlock } from './types';

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

export function researchIcon(calls: ToolCallBlock[]): string {
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

export function buildResearchHeadline(calls: ToolCallBlock[], results: ToolResultBlock[]): string {
	const counts = new Map<string, number>();
	for (const c of calls) counts.set(c.name, (counts.get(c.name) || 0) + 1);

	const parts: string[] = [];
	for (const [name, count] of counts) parts.push(displayToolName(name, count));

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
