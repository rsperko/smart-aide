import { describe, expect, it } from 'vitest';
import { __testing } from '../src/providers/anthropic';
import type { CustomMessageEntry, MessageEntry } from '../src/types';

const { renderMessages, buildSystem, buildTools, buildHeaders } = __testing;

function user(id: string, parentId: string | null, content: string | MessageEntry['message']['content']): MessageEntry {
	return {
		type: 'message',
		id,
		parentId,
		timestamp: '2026-05-23T10:00:00.000Z',
		message: { role: 'user', content: content as never },
	};
}

const noImage = async () => null;

describe('anthropic renderMessages', () => {
	it('converts a plain user turn into a user message with a text block (no role:system entry)', async () => {
		const msgs = await renderMessages([user('1', null, 'q')], noImage);
		expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
	});

	it('emits tool_use blocks inside assistant and tool_result blocks inside user', async () => {
		const u = user('1', null, 'do thing');
		const asst: MessageEntry = {
			type: 'message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'looking…' },
					{ type: 'toolCall', id: 'tu_1', name: 'search_vault', arguments: { query: 'x' } },
				],
			},
		};
		const tool: MessageEntry = {
			type: 'message',
			id: '3',
			parentId: '2',
			timestamp: '2026-05-23T10:00:02.000Z',
			message: {
				role: 'tool',
				content: [{ type: 'toolResult', toolCallId: 'tu_1', content: '{"matches":0}' }],
			},
		};
		const msgs = await renderMessages([u, asst, tool], noImage);
		expect(msgs[1].role).toBe('assistant');
		expect(msgs[1].content).toEqual([
			{ type: 'text', text: 'looking…' },
			{ type: 'tool_use', id: 'tu_1', name: 'search_vault', input: { query: 'x' } },
		]);
		expect(msgs[2].role).toBe('user');
		expect(msgs[2].content).toEqual([
			{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"matches":0}' },
		]);
	});

	it('flags is_error on tool_result when the Pi block was marked error', async () => {
		const asst: MessageEntry = {
			type: 'message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'assistant',
				content: [{ type: 'toolCall', id: 'tu_1', name: 'read_note', arguments: {} }],
			},
		};
		const tool: MessageEntry = {
			type: 'message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			message: {
				role: 'tool',
				content: [{ type: 'toolResult', toolCallId: 'tu_1', content: 'kaboom', isError: true }],
			},
		};
		const msgs = await renderMessages([asst, tool], noImage);
		expect(msgs[1].content).toEqual([
			{ type: 'tool_result', tool_use_id: 'tu_1', content: 'kaboom', is_error: true },
		]);
	});

	it('encodes a user image block as inlineData with base64 source', async () => {
		const u = user('1', null, [
			{ type: 'text', text: 'see this' },
			{ type: 'image', path: 'attachments/p.jpg', mime: 'image/jpeg' },
		]);
		const resolveImage = async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
		const msgs = await renderMessages([u], resolveImage);
		const blocks = msgs[0].content as Array<Record<string, unknown>>;
		expect(blocks[0]).toEqual({ type: 'text', text: 'see this' });
		expect(blocks[1]).toMatchObject({
			type: 'image',
			source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' },
		});
	});

	it('substitutes a text note when the image cannot be resolved', async () => {
		const u = user('1', null, [{ type: 'image', path: 'attachments/missing.jpg', mime: 'image/jpeg' }]);
		const msgs = await renderMessages([u], noImage);
		const blocks = msgs[0].content as Array<{ type: string; text?: string }>;
		expect(blocks[0].type).toBe('text');
		expect(blocks[0].text).toMatch(/not found.*attachments\/missing.jpg/);
	});

	it('labels skill custom_message as a user-role context block', async () => {
		const skill: CustomMessageEntry = {
			type: 'custom_message',
			id: '1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			customType: 'skill',
			content: 'SKILL BODY',
			display: 'skill: note-capture',
		};
		const msgs = await renderMessages([skill], noImage);
		expect(msgs[0].role).toBe('user');
		const text = (msgs[0].content[0] as { text: string }).text;
		expect(text).toContain('Loaded skill: note-capture');
		expect(text).toContain('SKILL BODY');
	});

	it('injects pinnedPreamble into the most recent user-text message, skipping pure tool_result messages', async () => {
		const u1 = user('1', null, 'oldest user message');
		const asst: MessageEntry = {
			type: 'message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			message: {
				role: 'assistant',
				content: [{ type: 'toolCall', id: 'tu_1', name: 'read_note', arguments: {} }],
			},
		};
		const tool: MessageEntry = {
			type: 'message',
			id: '3',
			parentId: '2',
			timestamp: '2026-05-23T10:00:02.000Z',
			message: {
				role: 'tool',
				content: [{ type: 'toolResult', toolCallId: 'tu_1', content: '{}' }],
			},
		};
		const u2 = user('4', '3', 'follow-up');
		const msgs = await renderMessages([u1, asst, tool, u2], noImage, '📌 pinned');

		// The pure tool_result user message (index 2) must stay unmodified.
		expect(msgs[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'tu_1', content: '{}' }]);
		// The follow-up user message (index 3) is the injection target.
		expect((msgs[3].content[0] as { text: string }).text).toBe('📌 pinned\n\n---\n\n');
		expect((msgs[3].content[1] as { text: string }).text).toBe('follow-up');
	});
});

describe('anthropic buildSystem', () => {
	it('returns the plain string when caching is disabled', () => {
		expect(buildSystem('SYS', false)).toBe('SYS');
	});

	it('returns a block array with cache_control when caching is enabled', () => {
		expect(buildSystem('SYS', true)).toEqual([
			{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
		]);
	});

	it('passes an empty system through untouched even with caching on', () => {
		expect(buildSystem('', true)).toBe('');
	});
});

describe('anthropic buildTools', () => {
	const tools = [
		{ name: 'a', description: 'da', parameters: { type: 'object', properties: {} } },
		{ name: 'b', description: 'db', parameters: { type: 'object', properties: {} } },
	];

	it('maps each tool descriptor to {name, description, input_schema}', () => {
		const out = buildTools(tools, false);
		expect(out).toEqual([
			{ name: 'a', description: 'da', input_schema: { type: 'object', properties: {} } },
			{ name: 'b', description: 'db', input_schema: { type: 'object', properties: {} } },
		]);
	});

	it('puts a single cache_control breakpoint on the last tool when caching is enabled', () => {
		const out = buildTools(tools, true);
		expect(out[0].cache_control).toBeUndefined();
		expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
	});

	it('returns an empty array for no tools', () => {
		expect(buildTools([], true)).toEqual([]);
	});
});

describe('anthropic buildHeaders', () => {
	const ep = (apiKey = '', headers?: Record<string, string>) => ({
		id: 'e1',
		name: 'Anthropic Local',
		baseURL: 'http://localhost:8000',
		apiKey,
		headers,
	});

	it('omits x-api-key when apiKey is empty (local proxy / no-key endpoints)', () => {
		const h = buildHeaders(ep(''));
		expect(h['x-api-key']).toBeUndefined();
		expect(h['Content-Type']).toBe('application/json');
		expect(h['anthropic-version']).toBeTruthy();
		expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
	});

	it('includes x-api-key when apiKey is set', () => {
		const h = buildHeaders(ep('sk-ant-secret'));
		expect(h['x-api-key']).toBe('sk-ant-secret');
	});
});
