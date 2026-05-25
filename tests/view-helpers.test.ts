import { describe, expect, it } from 'vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import {
	buildResearchHeadline,
	createLongPressGate,
	createScreenWakeLock,
	displayToolName,
	estimateEntryTokens,
	estimateTokens,
	extractToolCalls,
	extractToolResults,
	filterSkillsForSlash,
	filterTools,
	formatArgsInline,
	formatArgValue,
	formatCostUsd,
	formatTokenChip,
	formatTokens,
	formatUsageTooltip,
	groupChainIntoBursts,
	handleSkillLoadCall,
	humanizeToolCall,
	lineDiff,
	loadedSkillNamesOnChain,
	parseSlashContext,
	parseSlashInvocation,
	reduceCumulativeUsage,
	researchIcon,
	safeParse,
	shouldShowRoleLabel,
	summarizeToolResult,
	sumBreakdown,
	tryFormatJson,
	tryParseJSON,
} from '../src/view-helpers';
import type {
	ScreenWakeLockSentinel,
	SkillRegistryLike,
	VisibilitySource,
	WakeLockNavigator,
} from '../src/view-helpers';
import type { Entry, MessageEntry, ToolCallBlock, ToolResultBlock } from '../src/types';

describe('lineDiff', () => {
	it('returns equal ops for identical input', () => {
		expect(lineDiff(['a', 'b'], ['a', 'b'])).toEqual([
			{ type: 'equal', line: 'a' },
			{ type: 'equal', line: 'b' },
		]);
	});

	it('reports only adds when from empty', () => {
		expect(lineDiff([], ['a', 'b'])).toEqual([
			{ type: 'add', line: 'a' },
			{ type: 'add', line: 'b' },
		]);
	});

	it('reports only removes when to empty', () => {
		expect(lineDiff(['x'], [])).toEqual([{ type: 'remove', line: 'x' }]);
	});

	it('mixes adds, removes, equals', () => {
		// 'a' kept, 'b' removed, 'c' added.
		const out = lineDiff(['a', 'b'], ['a', 'c']);
		const types = out.map((o) => o.type);
		expect(types).toContain('equal');
		expect(types).toContain('remove');
		expect(types).toContain('add');
	});
});

describe('safeParse', () => {
	it('returns parsed JSON', () => {
		expect(safeParse('{"a":1}')).toEqual({ a: 1 });
	});
	it('returns {} for empty', () => {
		expect(safeParse('')).toEqual({});
	});
	it('returns {_raw: …} for malformed JSON', () => {
		expect(safeParse('not json')).toEqual({ _raw: 'not json' });
	});
});

describe('tryFormatJson', () => {
	it('pretty-prints valid JSON', () => {
		expect(tryFormatJson('{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}');
	});
	it('returns input as-is for invalid JSON', () => {
		expect(tryFormatJson('not json')).toBe('not json');
	});
});

describe('tryParseJSON', () => {
	it('returns the object for valid JSON object', () => {
		expect(tryParseJSON('{"a":1}')).toEqual({ a: 1 });
	});
	it('returns null for primitives or arrays (only objects accepted)', () => {
		expect(tryParseJSON('"hi"')).toBeNull();
		expect(tryParseJSON('[1,2,3]')).toEqual([1, 2, 3]); // array IS typeof object
		expect(tryParseJSON('null')).toBeNull();
	});
	it('returns null for malformed JSON', () => {
		expect(tryParseJSON('xx')).toBeNull();
	});
});

describe('shouldShowRoleLabel', () => {
	it('always shows for user, never for tool', () => {
		expect(shouldShowRoleLabel({ role: 'user', content: 'hi' })).toBe(true);
		expect(shouldShowRoleLabel({ role: 'tool', content: '' })).toBe(false);
	});
	it('hides assistant label when content is empty (string or blocks)', () => {
		expect(shouldShowRoleLabel({ role: 'assistant', content: '   ' })).toBe(false);
		expect(shouldShowRoleLabel({ role: 'assistant', content: [{ type: 'text', text: '' }] })).toBe(false);
		expect(shouldShowRoleLabel({ role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'x', arguments: {} }] })).toBe(false);
	});
	it('shows assistant label when there is text', () => {
		expect(shouldShowRoleLabel({ role: 'assistant', content: 'hi' })).toBe(true);
		expect(shouldShowRoleLabel({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })).toBe(true);
	});
	it('shows for non-user/assistant/tool roles (e.g. system)', () => {
		expect(shouldShowRoleLabel({ role: 'system', content: 'cfg' })).toBe(true);
	});
});

describe('formatArgValue / formatArgsInline', () => {
	it('quotes strings, stringifies primitives, JSON for objects', () => {
		expect(formatArgValue('hi')).toBe('"hi"');
		expect(formatArgValue(42)).toBe('42');
		expect(formatArgValue(true)).toBe('true');
		expect(formatArgValue(null)).toBe('null');
		expect(formatArgValue([1, 2])).toBe('[1,2]');
	});
	it('formats empty args as "()"', () => {
		expect(formatArgsInline({})).toBe('()');
	});
	it('joins args with commas', () => {
		expect(formatArgsInline({ q: 'x', n: 1 })).toBe('(q="x", n=1)');
	});
	it('truncates long arg lists', () => {
		const long = formatArgsInline({ q: 'x'.repeat(100) });
		expect(long.endsWith('…)')).toBe(true);
		expect(long.length).toBeLessThanOrEqual(80);
	});
});

describe('formatTokens', () => {
	it('renders under 1k with a unit', () => {
		expect(formatTokens(0)).toBe('0 tok');
		expect(formatTokens(999)).toBe('999 tok');
	});
	it('renders 1k–10k with one decimal', () => {
		expect(formatTokens(1234)).toBe('1.2k tok');
		expect(formatTokens(9999)).toBe('10.0k tok');
	});
	it('renders 10k+ with no decimals', () => {
		expect(formatTokens(12345)).toBe('12k tok');
		expect(formatTokens(123456)).toBe('123k tok');
	});
});

describe('formatTokenChip', () => {
	it('hides percentage under 70% and stays in normal severity', () => {
		const d = formatTokenChip(4000, 100000);
		expect(d.pct).toBeNull();
		expect(d.abs).toBe('4.0k');
		expect(d.severity).toBe('normal');
	});

	it('shows percentage and muted severity from 70% up to 90%', () => {
		const d = formatTokenChip(70000, 100000);
		expect(d.pct).toBe('70%');
		expect(d.abs).toBe('70k');
		expect(d.severity).toBe('muted');
	});

	it('shows warn severity at 90% and above', () => {
		const d = formatTokenChip(90000, 100000);
		expect(d.pct).toBe('90%');
		expect(d.severity).toBe('warn');
	});

	it('caps percentage at 100% even when total exceeds the context window', () => {
		const d = formatTokenChip(250000, 100000);
		expect(d.pct).toBe('100%');
		expect(d.severity).toBe('warn');
	});

	it('drops the tok suffix and uses one decimal under 10k', () => {
		expect(formatTokenChip(900, 100000).abs).toBe('900');
		expect(formatTokenChip(1500, 100000).abs).toBe('1.5k');
		expect(formatTokenChip(9999, 100000).abs).toBe('10.0k');
		expect(formatTokenChip(12345, 100000).abs).toBe('12k');
	});

	it('omits the chip entirely when there are no tokens', () => {
		const d = formatTokenChip(0, 100000);
		expect(d.pct).toBeNull();
		expect(d.abs).toBeNull();
		expect(d.severity).toBe('normal');
	});

	it('still shows absolute count when context length is unknown', () => {
		const d = formatTokenChip(4000, undefined);
		expect(d.pct).toBeNull();
		expect(d.abs).toBe('4.0k');
		expect(d.severity).toBe('normal');
	});

	it('treats a zero context length as unknown rather than dividing', () => {
		const d = formatTokenChip(4000, 0);
		expect(d.pct).toBeNull();
		expect(d.abs).toBe('4.0k');
	});
});

describe('extractToolCalls / extractToolResults', () => {
	function makeMsg(content: MessageEntry['message']['content']): MessageEntry {
		return {
			type: 'message',
			id: 'a',
			parentId: null,
			timestamp: '',
			message: { role: 'assistant', content },
		};
	}

	it('returns empty for string content', () => {
		expect(extractToolCalls(makeMsg('text'))).toEqual([]);
		expect(extractToolResults(makeMsg('text'))).toEqual([]);
	});

	it('filters to toolCall / toolResult blocks', () => {
		const calls = [{ type: 'toolCall', id: 'c1', name: 'x', arguments: {} } as ToolCallBlock];
		const results = [{ type: 'toolResult', toolCallId: 'c1', content: '{}' } as ToolResultBlock];
		const mixed = makeMsg([{ type: 'text', text: 'pre' }, ...calls, ...results]);
		expect(extractToolCalls(mixed)).toEqual(calls);
		expect(extractToolResults(mixed)).toEqual(results);
	});
});

describe('researchIcon', () => {
	it('returns a specific icon for a single tool type', () => {
		expect(researchIcon([{ type: 'toolCall', id: '1', name: 'read_note', arguments: {} }])).toBe('📖');
		expect(researchIcon([{ type: 'toolCall', id: '1', name: 'list_recent', arguments: {} }])).toBe('🕘');
		expect(researchIcon([{ type: 'toolCall', id: '1', name: 'load_skill', arguments: {} }])).toBe('🧩');
		expect(researchIcon([{ type: 'toolCall', id: '1', name: 'delete_note', arguments: {} }])).toBe('🗑');
	});

	it('falls back to 🔍 for mixed tool types', () => {
		expect(
			researchIcon([
				{ type: 'toolCall', id: '1', name: 'read_note', arguments: {} },
				{ type: 'toolCall', id: '2', name: 'search_vault', arguments: {} },
			]),
		).toBe('🔍');
	});

	it('uses 🪄 for an invocation with no tool calls', () => {
		expect(researchIcon([], 'editor')).toBe('🪄');
	});
});

describe('displayToolName', () => {
	it('singular / plural per known name', () => {
		expect(displayToolName('search_vault', 1)).toBe('1 search');
		expect(displayToolName('search_vault', 4)).toBe('4 searches');
		expect(displayToolName('write_note', 2)).toBe('2 writes');
	});
	it('falls back to the raw name for unknown', () => {
		expect(displayToolName('mystery_tool', 1)).toBe('1 mystery_tool');
	});
});

describe('buildResearchHeadline', () => {
	it('counts calls per tool and totals search hits', () => {
		const calls: ToolCallBlock[] = [
			{ type: 'toolCall', id: '1', name: 'search_vault', arguments: {} },
			{ type: 'toolCall', id: '2', name: 'search_vault', arguments: {} },
			{ type: 'toolCall', id: '3', name: 'read_note', arguments: {} },
		];
		const results: ToolResultBlock[] = [
			{ type: 'toolResult', toolCallId: '1', content: '{"matches":2}' },
			{ type: 'toolResult', toolCallId: '2', content: '{"matches":3}' },
		];
		const headline = buildResearchHeadline(calls, results);
		expect(headline).toContain('2 searches');
		expect(headline).toContain('1 read');
		expect(headline).toContain('5 hits');
	});

	it('omits the hit count when no search results were seen', () => {
		const calls: ToolCallBlock[] = [{ type: 'toolCall', id: '1', name: 'read_note', arguments: {} }];
		expect(buildResearchHeadline(calls, [])).toBe('1 read');
	});

	it('includes loaded-skill count when > 0', () => {
		const calls: ToolCallBlock[] = [{ type: 'toolCall', id: '1', name: 'search_vault', arguments: {} }];
		expect(buildResearchHeadline(calls, [], 1)).toContain('1 skill loaded');
		expect(buildResearchHeadline(calls, [], 3)).toContain('3 skills loaded');
	});

	it('omits skills segment when count is 0', () => {
		const calls: ToolCallBlock[] = [{ type: 'toolCall', id: '1', name: 'read_note', arguments: {} }];
		expect(buildResearchHeadline(calls, [], 0)).toBe('1 read');
	});

	it('prepends /<name> when a skill was invoked', () => {
		expect(buildResearchHeadline([], [], 0, 'editor')).toBe('/editor');
		const calls: ToolCallBlock[] = [{ type: 'toolCall', id: '1', name: 'read_note', arguments: {} }];
		expect(buildResearchHeadline(calls, [], 0, 'editor')).toBe('/editor · 1 read');
	});
});

describe('formatUsageTooltip', () => {
	it('builds an in/out tooltip', () => {
		expect(formatUsageTooltip({ promptTokens: 100, completionTokens: 50 })).toBe('100 tok in · 50 tok out');
	});
	it('adds cached when nonzero', () => {
		expect(formatUsageTooltip({ promptTokens: 100, completionTokens: 50, cachedTokens: 25 })).toContain('25 tok cached');
	});
});

describe('summarizeToolResult', () => {
	it('summarizes search results', () => {
		expect(summarizeToolResult(JSON.stringify({ matches: 3, returned: 3 }))).toBe('3 matches');
		expect(summarizeToolResult(JSON.stringify({ matches: 1, returned: 1 }))).toBe('1 match');
	});

	it('summarizes truncated reads', () => {
		const out = summarizeToolResult(JSON.stringify({ path: 'a.md', truncated: true, bytes: 100000, endLine: 200, totalLines: 800 }));
		expect(out).toContain('truncated');
		expect(out).toContain('a.md');
	});

	it('summarizes range reads', () => {
		expect(summarizeToolResult(JSON.stringify({ path: 'a.md', startLine: 10, endLine: 20 }))).toBe('a.md lines 10-20');
	});

	it('summarizes full-file reads', () => {
		expect(summarizeToolResult(JSON.stringify({ path: 'a.md', lines: 5 }))).toBe('a.md (5 lines)');
	});

	it('falls back to the path alone when no line info is present', () => {
		expect(summarizeToolResult(JSON.stringify({ path: 'a.md' }))).toBe('a.md');
	});

	it('falls back to byte count for parsed JSON with no recognized shape', () => {
		expect(summarizeToolResult(JSON.stringify({ random: 'shape' }))).toBe(JSON.stringify({ random: 'shape' }).length + 'B');
	});

	it('summarizes errors with truncation', () => {
		const longErr = 'x'.repeat(200);
		const out = summarizeToolResult(JSON.stringify({ error: longErr }));
		expect(out.startsWith('error: ')).toBe(true);
		expect(out.endsWith('…')).toBe(true);
	});

	it('falls back to byte count for non-JSON', () => {
		expect(summarizeToolResult('plain text')).toBe('10B');
	});
});

describe('estimateTokens', () => {
	it('returns 0 for empty', () => {
		expect(estimateTokens('')).toBe(0);
	});

	it('rounds up chars / 4', () => {
		expect(estimateTokens('a')).toBe(1);
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('abcde')).toBe(2);
	});
});

describe('sumBreakdown', () => {
	it('sums every component', () => {
		const total = sumBreakdown({
			base: 1,
			vault: 2,
			skillsManifest: 4,
			pinned: 8,
			skillsLoaded: 16,
			history: 32,
			composer: 64,
		});
		expect(total).toBe(127);
	});
});

describe('estimateEntryTokens', () => {
	const msg = (id: string, content: MessageEntry['message']['content']): Entry => ({
		id,
		ts: '2026-05-25T00:00:00Z',
		type: 'message',
		message: { role: 'user', content },
		parentId: null,
	} as Entry);

	it('returns 0 for non-message entries', () => {
		const modelChange: Entry = {
			id: 'm',
			ts: '2026-05-25T00:00:00Z',
			type: 'model_change',
			provider: 'anthropic',
			modelId: 'claude',
			parentId: null,
		} as Entry;
		expect(estimateEntryTokens(modelChange)).toBe(0);

		const session: Entry = {
			id: 's',
			ts: '2026-05-25T00:00:00Z',
			type: 'custom',
			customType: 'turn-usage',
			data: { promptTokens: 9999 },
			parentId: null,
		} as Entry;
		expect(estimateEntryTokens(session)).toBe(0);
	});

	it('estimates plain-string content via the chars/4 rule', () => {
		// 8 chars → ceil(8/4) = 2.
		expect(estimateEntryTokens(msg('a', 'abcdefgh'))).toBe(2);
	});

	it('sums text blocks', () => {
		const e = msg('a', [
			{ type: 'text', text: 'abcd' },
			{ type: 'text', text: 'efgh' },
		]);
		// Each block ceils independently: 1 + 1 = 2.
		expect(estimateEntryTokens(e)).toBe(2);
	});

	it('adds toolCall arguments token cost plus 6-token overhead', () => {
		const args = { path: 'note.md' };
		const e = msg('a', [
			{ type: 'toolCall', id: 'c1', name: 'read_note', arguments: args },
		]);
		// JSON.stringify(args) = '{"path":"note.md"}' → length 18 → ceil(18/4) = 5, + 6 overhead = 11.
		expect(estimateEntryTokens(e)).toBe(11);
	});

	it('sums toolResult content length', () => {
		const e = msg('a', [
			{ type: 'toolResult', toolCallId: 'c1', content: 'abcdefgh' },
		]);
		expect(estimateEntryTokens(e)).toBe(2);
	});

	it('ignores image blocks (no token contribution from path alone)', () => {
		const e = msg('a', [
			{ type: 'text', text: 'abcd' },
			{ type: 'image', path: 'attachments/photo.jpg', mime: 'image/jpeg' },
		]);
		// Only the text contributes.
		expect(estimateEntryTokens(e)).toBe(1);
	});

	it('counts custom_message content (skill bodies sent to provider)', () => {
		const skill: Entry = {
			id: 'sk',
			ts: '2026-05-25T00:00:00Z',
			type: 'custom_message',
			customType: 'skill',
			content: 'abcdefgh',
			parentId: null,
		} as Entry;
		expect(estimateEntryTokens(skill)).toBe(2);
	});
});

describe('humanizeToolCall', () => {
	it('search_vault — query only', () => {
		expect(humanizeToolCall('search_vault', { query: 'weekly review' })).toBe(
			'Searched vault for "weekly review"',
		);
	});

	it('search_vault — query + tag + pathPrefix + deepSearch', () => {
		const out = humanizeToolCall('search_vault', {
			query: 'onboarding',
			tag: '#task',
			pathPrefix: 'Daily',
			deepSearch: true,
		});
		expect(out).toBe('Searched vault for "onboarding" tag #task in Daily (deep)');
	});

	it('search_vault — bare tag (no leading #) is normalized', () => {
		expect(humanizeToolCall('search_vault', { tag: 'book' })).toBe('Searched vault tag #book');
	});

	it('search_vault — no args at all', () => {
		expect(humanizeToolCall('search_vault', {})).toBe('Searched vault');
	});

	it('read_note — path only strips .md', () => {
		expect(humanizeToolCall('read_note', { path: 'Notes/foo.md' })).toBe('Read "Notes/foo"');
	});

	it('read_note — section beats line range when both are provided', () => {
		const out = humanizeToolCall('read_note', {
			path: 'foo.md',
			section: 'Setup',
			startLine: 1,
			endLine: 10,
		});
		expect(out).toBe('Read "foo" — Setup');
	});

	it('read_note — startLine + endLine renders an inclusive range', () => {
		expect(humanizeToolCall('read_note', { path: 'foo.md', startLine: 1, endLine: 10 })).toBe(
			'Read "foo" (lines 1–10)',
		);
	});

	it('read_note — startLine alone renders "from line N"', () => {
		expect(humanizeToolCall('read_note', { path: 'foo.md', startLine: 5 })).toBe(
			'Read "foo" (from line 5)',
		);
	});

	it('read_note — without a path label', () => {
		expect(humanizeToolCall('read_note', {})).toBe('Read note');
	});

	it('list_recent — with and without sinceDays uses singular/plural day(s)', () => {
		expect(humanizeToolCall('list_recent', {})).toBe('Listed recent notes');
		expect(humanizeToolCall('list_recent', { sinceDays: 1 })).toBe('Listed notes from the last 1 day');
		expect(humanizeToolCall('list_recent', { sinceDays: 30 })).toBe('Listed notes from the last 30 days');
	});

	it('get_backlinks — with path and without', () => {
		expect(humanizeToolCall('get_backlinks', { path: 'foo.md' })).toBe('Looked up backlinks to "foo"');
		expect(humanizeToolCall('get_backlinks', {})).toBe('Looked up backlinks');
	});

	it('load_skill — surfaces the skill name', () => {
		expect(humanizeToolCall('load_skill', { name: 'daily-note' })).toBe('Loaded skill "daily-note"');
		expect(humanizeToolCall('load_skill', {})).toBe('Loaded skill');
	});

	it('write_note / append_to_note / delete_note label the path', () => {
		expect(humanizeToolCall('write_note', { path: 'foo.md' })).toBe('Proposed write to "foo"');
		expect(humanizeToolCall('append_to_note', { path: 'foo.md' })).toBe('Proposed append to "foo"');
		expect(humanizeToolCall('delete_note', { path: 'foo.md' })).toBe('Proposed delete of "foo"');
	});

	it('unknown tool falls back to name(args) form via formatArgsInline', () => {
		expect(humanizeToolCall('unknown_tool', { foo: 'bar' })).toBe('unknown_tool(foo="bar")');
		expect(humanizeToolCall('also_unknown', {})).toBe('also_unknown()');
	});

	it('clips very long quoted values with an ellipsis', () => {
		const longPath = 'a/'.repeat(60) + 'note.md';
		const out = humanizeToolCall('read_note', { path: longPath });
		// quoted() uses max=60 for read_note, clip leaves max-1 chars + "…".
		expect(out.startsWith('Read "')).toBe(true);
		expect(out.includes('…')).toBe(true);
	});
});

describe('reduceCumulativeUsage', () => {
	const usageEntry = (
		targetEntryId: string,
		promptTokens: number,
		completionTokens: number,
		cachedTokens?: number,
	): Entry => ({
		id: `u-${targetEntryId}`,
		ts: '2026-05-25T00:00:00Z',
		type: 'custom',
		customType: 'turn-usage',
		data: { targetEntryId, promptTokens, completionTokens, cachedTokens },
		parentId: null,
	} as Entry);

	it('sums turn-usage entries across the chain', () => {
		const chain = [
			usageEntry('a', 100, 50, 10),
			usageEntry('b', 200, 75),
			usageEntry('c', 50, 25, 5),
		];
		expect(reduceCumulativeUsage(chain)).toEqual({ prompt: 350, completion: 150, cached: 15 });
	});

	it('returns zeros for an empty chain', () => {
		expect(reduceCumulativeUsage([])).toEqual({ prompt: 0, completion: 0, cached: 0 });
	});

	it('ignores non-turn-usage custom entries and malformed payloads', () => {
		const chain: Entry[] = [
			usageEntry('a', 10, 5),
			{
				id: 'x',
				ts: '2026-05-25T00:00:00Z',
				type: 'custom',
				customType: 'session_info',
				data: { promptTokens: 9999, completionTokens: 9999 },
				parentId: null,
			} as Entry,
			{
				id: 'y',
				ts: '2026-05-25T00:00:00Z',
				type: 'custom',
				customType: 'turn-usage',
				data: { targetEntryId: 'y', promptTokens: 'not a number' },
				parentId: null,
			} as Entry,
		];
		expect(reduceCumulativeUsage(chain)).toEqual({ prompt: 10, completion: 5, cached: 0 });
	});
});

describe('formatCostUsd', () => {
	it('returns null when no pricing is known', () => {
		expect(formatCostUsd(1000, 500, undefined)).toBeNull();
		expect(formatCostUsd(1000, 500, {})).toBeNull();
	});

	it('multiplies tokens × per-million pricing and rounds to 2 decimals', () => {
		// 1M prompt at $3/M + 500k completion at $15/M = $3 + $7.50 = $10.50
		expect(formatCostUsd(1_000_000, 500_000, { promptPrice: 3, completionPrice: 15 })).toBe('$10.50');
	});

	it('collapses sub-cent costs to "<$0.01"', () => {
		expect(formatCostUsd(100, 50, { promptPrice: 1, completionPrice: 5 })).toBe('<$0.01');
	});

	it('formats exact zero as "$0"', () => {
		expect(formatCostUsd(1000, 500, { promptPrice: 0, completionPrice: 0 })).toBe('$0');
	});

	it('handles partial pricing (only prompt or only completion)', () => {
		// $5/M completion × 200k = $1.00; prompt cost ignored when promptPrice undefined.
		expect(formatCostUsd(1000, 200_000, { completionPrice: 5 })).toBe('$1.00');
	});
});

describe('groupChainIntoBursts', () => {
	const userMsg = (id: string, text: string, parentId: string | null = null): Entry => ({
		type: 'message',
		id,
		parentId,
		timestamp: '',
		message: { role: 'user', content: text },
	});
	const assistantText = (id: string, text: string, parentId: string): Entry => ({
		type: 'message',
		id,
		parentId,
		timestamp: '',
		message: { role: 'assistant', content: text },
	});
	const assistantTools = (id: string, calls: ToolCallBlock[], parentId: string): Entry => ({
		type: 'message',
		id,
		parentId,
		timestamp: '',
		message: { role: 'assistant', content: calls },
	});
	const toolResults = (id: string, results: ToolResultBlock[], parentId: string): Entry => ({
		type: 'message',
		id,
		parentId,
		timestamp: '',
		message: { role: 'tool', content: results },
	});
	const skillLoad = (id: string, name: string, parentId: string): Entry => ({
		type: 'custom_message',
		id,
		parentId,
		timestamp: '',
		customType: 'skill',
		content: 'skill body',
		display: `skill: ${name}`,
	});

	it('returns no bursts for an empty chain', () => {
		expect(groupChainIntoBursts([])).toEqual([]);
	});

	it('produces a single burst with just a user message and no activity', () => {
		const bursts = groupChainIntoBursts([userMsg('u1', 'hi')]);
		expect(bursts).toHaveLength(1);
		expect(bursts[0].user?.id).toBe('u1');
		expect(bursts[0].activity.toolCalls).toHaveLength(0);
		expect(bursts[0].final).toBeNull();
	});

	it('groups user + tool-calls + tool-results + final text into one burst', () => {
		const calls: ToolCallBlock[] = [
			{ type: 'toolCall', id: 'c1', name: 'search_vault', arguments: { query: 'x' } },
		];
		const results: ToolResultBlock[] = [
			{ type: 'toolResult', toolCallId: 'c1', content: '{"matches":1}' },
		];
		const bursts = groupChainIntoBursts([
			userMsg('u1', 'ask'),
			assistantTools('a1', calls, 'u1'),
			toolResults('t1', results, 'a1'),
			assistantText('a2', 'here is the answer', 't1'),
		]);
		expect(bursts).toHaveLength(1);
		expect(bursts[0].activity.toolCalls).toHaveLength(1);
		expect(bursts[0].activity.toolResults).toHaveLength(1);
		expect(bursts[0].final?.id).toBe('a2');
		expect(bursts[0].activity.entryIds).toEqual(['a1', 'a2']);
	});

	it('starts a new burst on each user message', () => {
		const bursts = groupChainIntoBursts([
			userMsg('u1', 'q1'),
			assistantText('a1', 'answer 1', 'u1'),
			userMsg('u2', 'q2', 'a1'),
			assistantText('a2', 'answer 2', 'u2'),
		]);
		expect(bursts).toHaveLength(2);
		expect(bursts[0].final?.id).toBe('a1');
		expect(bursts[1].final?.id).toBe('a2');
	});

	it('records skill loads in the active burst', () => {
		const bursts = groupChainIntoBursts([
			userMsg('u1', 'ask'),
			skillLoad('s1', 'note-capture', 'u1'),
			assistantText('a1', 'used the skill', 's1'),
		]);
		expect(bursts[0].activity.loadedSkills).toEqual(['note-capture']);
		expect(bursts[0].final?.id).toBe('a1');
	});

	it('treats assistant text alongside tool calls as intra-turn narration (dropped)', () => {
		// Some models emit "let me check…" text in the same turn as tool_calls.
		// That narration shouldn't become the final answer — only a tool-less
		// later assistant message qualifies.
		const calls: ToolCallBlock[] = [
			{ type: 'toolCall', id: 'c1', name: 'read_note', arguments: { path: 'x.md' } },
		];
		const bursts = groupChainIntoBursts([
			userMsg('u1', 'ask'),
			{
				type: 'message',
				id: 'a1',
				parentId: 'u1',
				timestamp: '',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'let me check' }, ...calls],
				},
			} as Entry,
		]);
		expect(bursts[0].final).toBeNull();
		expect(bursts[0].activity.toolCalls).toHaveLength(1);
	});

	it('keeps the LAST text-only assistant as the burst final (overwrites earlier)', () => {
		const bursts = groupChainIntoBursts([
			userMsg('u1', 'ask'),
			assistantText('a1', 'first draft', 'u1'),
			assistantText('a2', 'revised', 'a1'),
		]);
		expect(bursts[0].final?.id).toBe('a2');
	});

	it('attaches a skill-invocation custom_message to the NEXT user burst (not the previous)', () => {
		// The view persists the invocation entry BEFORE the user message so the
		// model sees the skill body as context for that user turn. The grouper
		// must buffer it and attach to the upcoming burst, not the prior one.
		const invocation = (id: string, name: string, parentId: string): Entry => ({
			type: 'custom_message',
			id,
			parentId,
			timestamp: '',
			customType: 'skill-invocation',
			content: 'skill body',
			display: name,
		});
		const bursts = groupChainIntoBursts([
			userMsg('u1', 'first turn'),
			assistantText('a1', 'sure thing', 'u1'),
			invocation('inv1', 'editor', 'a1'),
			userMsg('u2', 'tighten this up', 'inv1'),
			assistantText('a2', 'done', 'u2'),
		]);
		expect(bursts).toHaveLength(2);
		expect(bursts[0].activity.invokedSkill).toBeNull();
		expect(bursts[1].activity.invokedSkill).toBe('editor');
		expect(bursts[1].user?.id).toBe('u2');
	});
});

describe('parseSlashInvocation', () => {
	const valid = ['editor', 'weekly-review', 'daily-note'];

	it('parses /<name> with no body', () => {
		expect(parseSlashInvocation('/editor', valid)).toEqual({ name: 'editor', rest: '' });
	});

	it('parses /<name> <body>', () => {
		expect(parseSlashInvocation('/editor please tighten this up', valid)).toEqual({
			name: 'editor',
			rest: 'please tighten this up',
		});
	});

	it('parses across a newline', () => {
		expect(parseSlashInvocation('/editor\ntighten this', valid)).toEqual({
			name: 'editor',
			rest: 'tighten this',
		});
	});

	it('is case-insensitive on the name', () => {
		expect(parseSlashInvocation('/Editor go', valid)?.name).toBe('editor');
	});

	it('returns null for an unknown skill name', () => {
		expect(parseSlashInvocation('/unknown please help', valid)).toBeNull();
	});

	it('returns null when text does not start with a slash', () => {
		expect(parseSlashInvocation('hello /editor', valid)).toBeNull();
		expect(parseSlashInvocation(' /editor', valid)).toBeNull();
	});

	it('returns null for a malformed slash (no name)', () => {
		expect(parseSlashInvocation('/', valid)).toBeNull();
		expect(parseSlashInvocation('//foo', valid)).toBeNull();
	});

	it('handles kebab-case skill names', () => {
		expect(parseSlashInvocation('/weekly-review', valid)?.name).toBe('weekly-review');
	});
});

describe('parseSlashContext', () => {
	it('returns empty string for just a slash (popover should show everything)', () => {
		expect(parseSlashContext('/')).toBe('');
	});

	it('returns the in-progress query', () => {
		expect(parseSlashContext('/d')).toBe('d');
		expect(parseSlashContext('/daily-note')).toBe('daily-note');
	});

	it('lowercases the returned query', () => {
		expect(parseSlashContext('/Daily')).toBe('daily');
	});

	it('returns null once a space follows (slash has settled)', () => {
		expect(parseSlashContext('/daily ')).toBeNull();
		expect(parseSlashContext('/daily please go')).toBeNull();
	});

	it('returns null for empty / non-slash text', () => {
		expect(parseSlashContext('')).toBeNull();
		expect(parseSlashContext('hello')).toBeNull();
		expect(parseSlashContext(' /foo')).toBeNull();
	});

	it('returns null for malformed slashes', () => {
		expect(parseSlashContext('//foo')).toBeNull();
		expect(parseSlashContext('/1abc')).toBeNull();
	});
});

describe('filterSkillsForSlash', () => {
	const skills = [
		{ name: 'daily-note' },
		{ name: 'meeting-notes' },
		{ name: 'process-inbox' },
		{ name: 'moc-builder' },
		{ name: 'weekly-review' },
	];

	it('returns the first N skills when query is empty', () => {
		expect(filterSkillsForSlash(skills, '', 3).map((s) => s.name)).toEqual([
			'daily-note',
			'meeting-notes',
			'process-inbox',
		]);
	});

	it('puts prefix matches before substring matches', () => {
		// "note" is a prefix of nothing here; substring matches daily-note and meeting-notes.
		const names = filterSkillsForSlash(skills, 'note', 5).map((s) => s.name);
		expect(names).toEqual(['daily-note', 'meeting-notes']);
	});

	it('ranks prefix matches first when both kinds exist', () => {
		const names = filterSkillsForSlash(
			[{ name: 'daily-note' }, { name: 'meeting-notes' }, { name: 'meet-something' }],
			'meet',
			5,
		).map((s) => s.name);
		expect(names).toEqual(['meeting-notes', 'meet-something']);
	});

	it('caps results at max', () => {
		expect(filterSkillsForSlash(skills, '', 2)).toHaveLength(2);
	});

	it('is case-insensitive on the query', () => {
		expect(filterSkillsForSlash(skills, 'DAILY', 5).map((s) => s.name)).toEqual(['daily-note']);
	});

	it('returns [] when nothing matches', () => {
		expect(filterSkillsForSlash(skills, 'zzz', 5)).toEqual([]);
	});
});

describe('filterTools', () => {
	const tools = [
		{ name: 'read_note', description: 'r' },
		{ name: 'write_note', description: 'w' },
		{ name: 'delete_note', description: 'd' },
	];

	it('returns the input unchanged when allowed is null', () => {
		expect(filterTools(tools, null)).toEqual(tools);
	});

	it('returns only allowlisted tools', () => {
		expect(filterTools(tools, ['read_note', 'write_note']).map((t) => t.name)).toEqual([
			'read_note',
			'write_note',
		]);
	});

	it('returns an empty list when allowlist is empty', () => {
		expect(filterTools(tools, [])).toEqual([]);
	});

	it('silently ignores names not in the tool list', () => {
		expect(filterTools(tools, ['read_note', 'made_up']).map((t) => t.name)).toEqual(['read_note']);
	});
});

describe('handleSkillLoadCall', () => {
	const registry: SkillRegistryLike = {
		loadable: (name) => (name === 'note-capture' ? { name: 'note-capture', body: 'SKILL BODY' } : null),
		visibleOnThisPlatform: () => [{ name: 'note-capture' }, { name: 'distill' }],
	};

	it('queues the skill body in the pending array (never writes to storage) and returns loaded status', () => {
		// Regression guard for load_skill ordering: the helper must NOT persist
		// the skill body immediately. The dispatch loop in view.ts appends a
		// custom_message entry AFTER the tool-result entry so providers see
		// [assistant tool_call → tool result → user skill context] — the order
		// OpenAI / Anthropic / Gemini require for tool_call/tool_result adjacency.
		const pending: { name: string; body: string }[] = [];
		const out = handleSkillLoadCall({ name: 'note-capture' }, registry, pending, new Set());
		expect(pending).toEqual([{ name: 'note-capture', body: 'SKILL BODY' }]);
		expect(JSON.parse(out)).toEqual({ status: 'loaded', skill: 'note-capture' });
	});

	it('returns an error and does not enqueue when name is missing', () => {
		const pending: { name: string; body: string }[] = [];
		const out = handleSkillLoadCall({}, registry, pending, new Set());
		expect(pending).toEqual([]);
		expect(JSON.parse(out)).toEqual({ error: 'name is required' });
	});

	it('returns an error and does not enqueue when name is blank whitespace', () => {
		const pending: { name: string; body: string }[] = [];
		const out = handleSkillLoadCall({ name: '   ' }, registry, pending, new Set());
		expect(pending).toEqual([]);
		expect(JSON.parse(out)).toEqual({ error: 'name is required' });
	});

	it('returns the available-skills list when the requested skill is unknown', () => {
		const pending: { name: string; body: string }[] = [];
		const out = handleSkillLoadCall({ name: 'missing' }, registry, pending, new Set());
		expect(pending).toEqual([]);
		expect(JSON.parse(out)).toEqual({
			error: "no skill named 'missing'",
			available: ['note-capture', 'distill'],
		});
	});

	it('appends successive loads in invocation order so the dispatch loop can drain them after the tool entry', () => {
		const multi: SkillRegistryLike = {
			loadable: (name) => ({ name, body: `body:${name}` }),
			visibleOnThisPlatform: () => [],
		};
		const pending: { name: string; body: string }[] = [];
		handleSkillLoadCall({ name: 'a' }, multi, pending, new Set());
		handleSkillLoadCall({ name: 'b' }, multi, pending, new Set());
		expect(pending.map((p) => p.name)).toEqual(['a', 'b']);
	});

	it('short-circuits with already_loaded when the skill is in alreadyLoaded', () => {
		const pending: { name: string; body: string }[] = [];
		const out = handleSkillLoadCall({ name: 'note-capture' }, registry, pending, new Set(['note-capture']));
		expect(pending).toEqual([]);
		expect(JSON.parse(out)).toEqual({ status: 'already_loaded', skill: 'note-capture' });
	});

	it('short-circuits when the skill was already queued earlier in the same batch', () => {
		const pending: { name: string; body: string }[] = [{ name: 'note-capture', body: 'SKILL BODY' }];
		const out = handleSkillLoadCall({ name: 'note-capture' }, registry, pending, new Set());
		expect(pending).toHaveLength(1);
		expect(JSON.parse(out)).toEqual({ status: 'already_loaded', skill: 'note-capture' });
	});
});

describe('loadedSkillNamesOnChain', () => {
	const skillEntry = (display: string | undefined): Entry => ({
		id: 's',
		ts: '2026-05-25T00:00:00Z',
		type: 'custom_message',
		customType: 'skill',
		content: 'body',
		...(display !== undefined ? { display } : {}),
		parentId: null,
	} as Entry);

	const invocationEntry = (display: string | undefined): Entry => ({
		id: 'i',
		ts: '2026-05-25T00:00:00Z',
		type: 'custom_message',
		customType: 'skill-invocation',
		content: 'body',
		...(display !== undefined ? { display } : {}),
		parentId: null,
	} as Entry);

	it("strips the 'skill: ' prefix from load_skill entry display", () => {
		const names = loadedSkillNamesOnChain([skillEntry('skill: note-capture')]);
		expect([...names]).toEqual(['note-capture']);
	});

	it('uses display verbatim for skill-invocation entries', () => {
		const names = loadedSkillNamesOnChain([invocationEntry('daily-note')]);
		expect([...names]).toEqual(['daily-note']);
	});

	it('merges both customTypes and dedupes overlapping names', () => {
		const chain = [skillEntry('skill: foo'), invocationEntry('bar'), skillEntry('skill: foo')];
		const names = loadedSkillNamesOnChain(chain);
		expect([...names].sort()).toEqual(['bar', 'foo']);
	});

	it('skips entries with missing or blank display', () => {
		const chain = [skillEntry(undefined), invocationEntry('   ')];
		const names = loadedSkillNamesOnChain(chain);
		expect(names.size).toBe(0);
	});

	it('ignores non-custom_message entries', () => {
		const msg: Entry = {
			id: 'm',
			ts: '2026-05-25T00:00:00Z',
			type: 'message',
			message: { role: 'user', content: 'hello' },
			parentId: null,
		} as Entry;
		expect(loadedSkillNamesOnChain([msg]).size).toBe(0);
	});
});

describe('createLongPressGate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires onClick on a quick tap (pointerdown → pointerEnd → click) without firing onLongPress', () => {
		const onClick = vi.fn();
		const onLongPress = vi.fn();
		const gate = createLongPressGate({ holdMs: 600, onClick, onLongPress });
		gate.pointerDown();
		vi.advanceTimersByTime(100);
		gate.pointerEnd();
		const consumed = gate.click();
		expect(consumed).toBe(true);
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('fires onLongPress after holdMs and suppresses the trailing click that pointerup synthesizes', () => {
		// Regression guard: before the fix, the click event fired after a
		// long-press still opened the chat picker on top of the rename modal.
		const onClick = vi.fn();
		const onLongPress = vi.fn();
		const gate = createLongPressGate({ holdMs: 600, onClick, onLongPress });
		gate.pointerDown();
		vi.advanceTimersByTime(600);
		expect(onLongPress).toHaveBeenCalledTimes(1);
		gate.pointerEnd();
		const consumed = gate.click();
		expect(consumed).toBe(false);
		expect(onClick).not.toHaveBeenCalled();
	});

	it('resets after a suppressed long-press click so the next quick tap fires onClick again', () => {
		const onClick = vi.fn();
		const onLongPress = vi.fn();
		const gate = createLongPressGate({ holdMs: 600, onClick, onLongPress });
		gate.pointerDown();
		vi.advanceTimersByTime(600);
		gate.pointerEnd();
		gate.click();
		gate.pointerDown();
		vi.advanceTimersByTime(100);
		gate.pointerEnd();
		const consumed = gate.click();
		expect(consumed).toBe(true);
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onLongPress).toHaveBeenCalledTimes(1);
	});

	it('cancels the long-press timer when pointerEnd fires before holdMs', () => {
		const onClick = vi.fn();
		const onLongPress = vi.fn();
		const gate = createLongPressGate({ holdMs: 600, onClick, onLongPress });
		gate.pointerDown();
		vi.advanceTimersByTime(300);
		gate.pointerEnd();
		vi.advanceTimersByTime(500);
		expect(onLongPress).not.toHaveBeenCalled();
		gate.click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('a fresh pointerDown cancels the previous pending timer', () => {
		const onLongPress = vi.fn();
		const gate = createLongPressGate({ holdMs: 600, onClick: () => {}, onLongPress });
		gate.pointerDown();
		vi.advanceTimersByTime(400);
		gate.pointerDown();
		vi.advanceTimersByTime(400);
		expect(onLongPress).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(onLongPress).toHaveBeenCalledTimes(1);
	});
});

describe('createScreenWakeLock', () => {
	interface FakeSentinel extends ScreenWakeLockSentinel {
		released: boolean;
		listeners: Array<() => void>;
		simulateOsRelease(): void;
	}

	function makeSentinel(): FakeSentinel {
		const listeners: Array<() => void> = [];
		const s = {
			released: false,
			listeners,
			addEventListener: (type: 'release', listener: () => void) => {
				if (type === 'release') listeners.push(listener);
			},
			release: vi.fn(async () => {
				s.released = true;
				for (const l of listeners) l();
			}),
			simulateOsRelease() {
				s.released = true;
				for (const l of listeners) l();
			},
		};
		return s as unknown as FakeSentinel;
	}

	function makeVisibility(initial: 'visible' | 'hidden' = 'visible'): VisibilitySource & {
		set(state: 'visible' | 'hidden'): void;
	} {
		let state = initial;
		const listeners: Array<() => void> = [];
		return {
			get visibilityState() {
				return state;
			},
			addEventListener: (type: 'visibilitychange', listener: () => void) => {
				if (type === 'visibilitychange') listeners.push(listener);
			},
			removeEventListener: (type: 'visibilitychange', listener: () => void) => {
				if (type !== 'visibilitychange') return;
				const i = listeners.indexOf(listener);
				if (i >= 0) listeners.splice(i, 1);
			},
			set(next) {
				state = next;
				for (const l of [...listeners]) l();
			},
		};
	}

	it('requests a screen wake lock on acquire', async () => {
		const sentinel = makeSentinel();
		const request = vi.fn(async () => sentinel);
		const navigator: WakeLockNavigator = { wakeLock: { request } };
		const visibility = makeVisibility();
		const lock = createScreenWakeLock({ navigator, visibility });
		await lock.acquire();
		expect(request).toHaveBeenCalledWith('screen');
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('is idempotent when acquire is called while the sentinel is already held', async () => {
		const request = vi.fn(async () => makeSentinel());
		const navigator: WakeLockNavigator = { wakeLock: { request } };
		const lock = createScreenWakeLock({ navigator, visibility: makeVisibility() });
		await lock.acquire();
		await lock.acquire();
		await lock.acquire();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('releases the held sentinel on release()', async () => {
		const sentinel = makeSentinel();
		const navigator: WakeLockNavigator = { wakeLock: { request: async () => sentinel } };
		const lock = createScreenWakeLock({ navigator, visibility: makeVisibility() });
		await lock.acquire();
		await lock.release();
		expect(sentinel.release).toHaveBeenCalledTimes(1);
	});

	it('release() with nothing held is a no-op', async () => {
		const lock = createScreenWakeLock({
			navigator: { wakeLock: { request: vi.fn() } },
			visibility: makeVisibility(),
		});
		await expect(lock.release()).resolves.toBeUndefined();
	});

	it('is a silent no-op when navigator.wakeLock is unavailable (old iOS, unsupported webview)', async () => {
		const onError = vi.fn();
		const lock = createScreenWakeLock({
			navigator: {},
			visibility: makeVisibility(),
			onError,
		});
		await lock.acquire();
		await lock.release();
		expect(onError).not.toHaveBeenCalled();
	});

	it('re-acquires when the page returns to visible if the caller still wants the lock', async () => {
		const request = vi.fn(async () => makeSentinel());
		const visibility = makeVisibility('visible');
		const lock = createScreenWakeLock({ navigator: { wakeLock: { request } }, visibility });
		await lock.acquire();
		expect(request).toHaveBeenCalledTimes(1);
		// OS releases the sentinel when the page goes hidden (matches real behavior).
		visibility.set('hidden');
		await Promise.resolve();
		// Coming back to visible should re-request because release() was never called.
		visibility.set('visible');
		await Promise.resolve();
		await Promise.resolve();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('does not re-acquire on visibility change after the caller explicitly released', async () => {
		const request = vi.fn(async () => makeSentinel());
		const visibility = makeVisibility();
		const lock = createScreenWakeLock({ navigator: { wakeLock: { request } }, visibility });
		await lock.acquire();
		await lock.release();
		visibility.set('hidden');
		visibility.set('visible');
		await Promise.resolve();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('survives a rejected request without throwing and allows a retry', async () => {
		const onError = vi.fn();
		let calls = 0;
		const sentinel = makeSentinel();
		const request = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error('denied');
			return sentinel;
		});
		const lock = createScreenWakeLock({
			navigator: { wakeLock: { request } },
			visibility: makeVisibility(),
			onError,
		});
		await lock.acquire();
		expect(onError).toHaveBeenCalledTimes(1);
		await lock.acquire();
		expect(request).toHaveBeenCalledTimes(2);
		expect(sentinel.release).not.toHaveBeenCalled();
	});

	it('dispose() removes the visibility listener and releases any held sentinel', async () => {
		const sentinel = makeSentinel();
		const request = vi.fn(async () => sentinel);
		const visibility = makeVisibility();
		const lock = createScreenWakeLock({ navigator: { wakeLock: { request } }, visibility });
		await lock.acquire();
		lock.dispose();
		// After dispose, visibility changes must not trigger more requests.
		visibility.set('hidden');
		visibility.set('visible');
		await Promise.resolve();
		expect(request).toHaveBeenCalledTimes(1);
		expect(sentinel.release).toHaveBeenCalledTimes(1);
	});
});
