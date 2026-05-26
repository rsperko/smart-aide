import { describe, expect, it } from 'vitest';
import { __testing } from '../src/providers/gemini';
import type { CustomMessageEntry, MessageEntry } from '../src/types';

const { renderContents, buildTools, toolResultToResponse, buildHeaders, parseGeminiUsage } = __testing;

function userText(id: string, text: string, parentId: string | null = null): MessageEntry {
	return {
		type: 'message',
		id,
		parentId,
		timestamp: '2026-05-23T10:00:00.000Z',
		message: { role: 'user', content: text },
	};
}

const noImage = async () => null;

describe('gemini renderContents', () => {
	it('renders a plain user turn as a single user/text content', async () => {
		const contents = await renderContents([userText('1', 'q')], noImage);
		expect(contents).toEqual([{ role: 'user', parts: [{ text: 'q' }] }]);
	});

	it('uses role:"model" for assistant turns and emits functionCall parts (no IDs on the wire)', async () => {
		const asst: MessageEntry = {
			type: 'message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'looking…' },
					{ type: 'toolCall', id: 'gem_x', name: 'search_vault', arguments: { query: 'foo' } },
				],
			},
		};
		const contents = await renderContents([asst], noImage);
		expect(contents).toEqual([
			{
				role: 'model',
				parts: [
					{ text: 'looking…' },
					{ functionCall: { name: 'search_vault', args: { query: 'foo' } } },
				],
			},
		]);
	});

	it('maps tool_result blocks to functionResponse parts and recovers the tool name from the prior toolCall id', async () => {
		const asst: MessageEntry = {
			type: 'message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'assistant',
				content: [{ type: 'toolCall', id: 'gem_x', name: 'search_vault', arguments: { query: 'foo' } }],
			},
		};
		const tool: MessageEntry = {
			type: 'message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			message: {
				role: 'tool',
				content: [{ type: 'toolResult', toolCallId: 'gem_x', content: '{"matches":1,"results":[]}' }],
			},
		};
		const contents = await renderContents([asst, tool], noImage);
		expect(contents[1]).toEqual({
			role: 'user',
			parts: [
				{ functionResponse: { name: 'search_vault', response: { matches: 1, results: [] } } },
			],
		});
	});

	it('falls back to unknown_tool when a tool_result references an id we never saw', async () => {
		const orphan: MessageEntry = {
			type: 'message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'tool',
				content: [{ type: 'toolResult', toolCallId: 'missing', content: '{}' }],
			},
		};
		const contents = await renderContents([orphan], noImage);
		expect(contents[0].parts[0]).toEqual({
			functionResponse: { name: 'unknown_tool', response: {} },
		});
	});

	it('encodes a user image block as inlineData with base64', async () => {
		const u: MessageEntry = {
			type: 'message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'transcribe' },
					{ type: 'image', path: 'attachments/p.jpg', mime: 'image/jpeg' },
				],
			},
		};
		const resolveImage = async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
		const contents = await renderContents([u], resolveImage);
		expect(contents[0].parts).toEqual([
			{ text: 'transcribe' },
			{ inlineData: { mimeType: 'image/jpeg', data: '/9j/' } },
		]);
	});

	it('labels skill custom_message as a user-role part', async () => {
		const skill: CustomMessageEntry = {
			type: 'custom_message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			customType: 'skill',
			content: 'SKILL BODY',
			display: 'skill: note-capture',
		};
		const contents = await renderContents([skill], noImage);
		expect(contents[0].role).toBe('user');
		const text = (contents[0].parts[0] as { text: string }).text;
		expect(text).toContain('Loaded skill: note-capture');
		expect(text).toContain('SKILL BODY');
	});

	it('injects pinnedPreamble into the most recent user-text turn, skipping pure functionResponse turns', async () => {
		const u1 = userText('1', 'oldest', null);
		const asst: MessageEntry = {
			type: 'message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			message: {
				role: 'assistant',
				content: [{ type: 'toolCall', id: 't', name: 'read_note', arguments: {} }],
			},
		};
		const tool: MessageEntry = {
			type: 'message',
			id: '3',
			parentId: '2',
			timestamp: '2026-05-23T10:00:02.000Z',
			message: {
				role: 'tool',
				content: [{ type: 'toolResult', toolCallId: 't', content: '{}' }],
			},
		};
		const u2 = userText('4', 'follow-up', '3');
		const contents = await renderContents([u1, asst, tool, u2], noImage, '📌 pinned');
		// Pure functionResponse turn (index 2) must stay untouched.
		expect(contents[2].parts).toEqual([
			{ functionResponse: { name: 'read_note', response: {} } },
		]);
		// Pin lands on the follow-up turn (index 3).
		expect(contents[3].parts).toEqual([
			{ text: '📌 pinned\n\n---\n\n' },
			{ text: 'follow-up' },
		]);
	});
});

describe('gemini buildTools', () => {
	it('wraps descriptors in a single functionDeclarations entry', () => {
		const out = buildTools([
			{ name: 'a', description: 'da', parameters: { type: 'object', properties: {} } },
			{ name: 'b', description: 'db', parameters: { type: 'object', properties: {} } },
		]);
		expect(out).toEqual([
			{
				functionDeclarations: [
					{ name: 'a', description: 'da', parameters: { type: 'object', properties: {} } },
					{ name: 'b', description: 'db', parameters: { type: 'object', properties: {} } },
				],
			},
		]);
	});

	it('returns an empty array when there are no tools', () => {
		expect(buildTools([])).toEqual([]);
	});
});

describe('gemini toolResultToResponse', () => {
	it('passes through a JSON object payload', () => {
		expect(toolResultToResponse('{"matches":3}')).toEqual({ matches: 3 });
	});

	it('wraps JSON arrays under a result key', () => {
		expect(toolResultToResponse('[1,2,3]')).toEqual({ result: [1, 2, 3] });
	});

	it('wraps non-JSON strings under a result key', () => {
		expect(toolResultToResponse('plain text')).toEqual({ result: 'plain text' });
	});
});

describe('gemini buildHeaders', () => {
	const ep = (apiKey = '', headers?: Record<string, string>) => ({
		id: 'e1',
		name: 'Gemini Local',
		baseURL: 'http://localhost:8000',
		apiKey,
		headers,
	});

	it('omits x-goog-api-key when apiKey is empty', () => {
		const h = buildHeaders(ep(''));
		expect(h['x-goog-api-key']).toBeUndefined();
		expect(h['Content-Type']).toBe('application/json');
	});

	it('includes x-goog-api-key when apiKey is set', () => {
		const h = buildHeaders(ep('AIzaSecret'));
		expect(h['x-goog-api-key']).toBe('AIzaSecret');
	});
});

describe('parseGeminiUsage — implicit prompt-caching plumbing', () => {
	it('reads promptTokenCount and candidatesTokenCount into the cross-provider shape', () => {
		const u = parseGeminiUsage({ promptTokenCount: 1200, candidatesTokenCount: 80 });
		expect(u).toEqual({ promptTokens: 1200, completionTokens: 80 });
	});

	it('plumbs cachedContentTokenCount through as cachedReadTokens (Gemini 2.5 implicit caching)', () => {
		const u = parseGeminiUsage({
			promptTokenCount: 1200,
			candidatesTokenCount: 80,
			cachedContentTokenCount: 1000,
		});
		expect(u).toEqual({
			promptTokens: 1200,
			completionTokens: 80,
			cachedReadTokens: 1000,
		});
	});

	it('drops cachedReadTokens when the cached count is 0 (no implicit cache hit)', () => {
		const u = parseGeminiUsage({
			promptTokenCount: 1200,
			candidatesTokenCount: 80,
			cachedContentTokenCount: 0,
		});
		expect(u).toEqual({ promptTokens: 1200, completionTokens: 80 });
	});

	it('returns null for an empty / missing payload', () => {
		expect(parseGeminiUsage(undefined)).toBeNull();
		expect(parseGeminiUsage(null)).toBeNull();
	});

	it('defaults missing token counts to 0 rather than NaN', () => {
		const u = parseGeminiUsage({ promptTokenCount: 100 });
		expect(u).toEqual({ promptTokens: 100, completionTokens: 0 });
	});
});
