import { describe, expect, it } from 'vitest';
import {
	buildResearchHeadline,
	displayToolName,
	extractToolCalls,
	extractToolResults,
	formatArgsInline,
	formatArgValue,
	formatTokens,
	formatUsageTooltip,
	lineDiff,
	researchIcon,
	safeParse,
	shouldShowRoleLabel,
	summarizeToolResult,
	tryFormatJson,
	tryParseJSON,
} from '../src/view-helpers';
import type { MessageEntry, ToolCallBlock, ToolResultBlock } from '../src/types';

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
