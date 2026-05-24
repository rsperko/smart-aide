import { describe, expect, it } from 'vitest';
import { __testing } from '../src/providers/openai-compat';
import type { Entry, MessageEntry, CustomMessageEntry } from '../src/types';

const { renderMessages, toolsToOpenAI, buildHeaders } = __testing;

function endpoint(over: Partial<{
	id: string;
	name: string;
	baseURL: string;
	apiKey: string;
	headers?: Record<string, string>;
}> = {}) {
	return {
		id: 'e1',
		name: 'Local',
		baseURL: 'http://localhost:11434/v1',
		apiKey: '',
		...over,
	};
}

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

describe('openai-compat renderMessages', () => {
	it('prepends a system message and converts a string user turn', async () => {
		const msgs = await renderMessages([userText('1', 'q')], 'SYS', noImage);
		expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
		expect(msgs[1]).toEqual({ role: 'user', content: 'q' });
	});

	it('emits multi-part content when a user message has an image block', async () => {
		const u: MessageEntry = {
			type: 'message',
			id: 'u1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'what is in this photo?' },
					{ type: 'image', path: 'attachments/p.jpg', mime: 'image/jpeg' },
				],
			},
		};
		const resolveImage = async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
		const msgs = await renderMessages([u], 'SYS', resolveImage);
		expect(msgs[1].role).toBe('user');
		const parts = msgs[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
		expect(parts[0]).toEqual({ type: 'text', text: 'what is in this photo?' });
		expect(parts[1].type).toBe('image_url');
		expect(parts[1].image_url!.url).toBe('data:image/jpeg;base64,/9j/');
	});

	it('substitutes a text note when an image cannot be resolved', async () => {
		const u: MessageEntry = {
			type: 'message',
			id: 'u1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'see attached' },
					{ type: 'image', path: 'attachments/missing.jpg', mime: 'image/jpeg' },
				],
			},
		};
		const msgs = await renderMessages([u], 'SYS', noImage);
		const parts = msgs[1].content as Array<{ type: string; text?: string }>;
		const noteText = parts.map((p) => p.text ?? '').join(' ');
		expect(noteText).toMatch(/not found.*attachments\/missing.jpg/);
	});

	it('converts assistant tool calls to tool_calls and tool messages to role:tool', async () => {
		const user = userText('1', 'q');
		const asst: MessageEntry = {
			type: 'message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'thinking' },
					{ type: 'toolCall', id: 'call-1', name: 'search_vault', arguments: { query: 'x' } },
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
				content: [{ type: 'toolResult', toolCallId: 'call-1', content: '{"matches":0}' }],
			},
		};
		const msgs = await renderMessages([user, asst, tool], 'SYS', noImage);
		expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
		expect(msgs[1].content).toBe('q');
		expect(msgs[2].role).toBe('assistant');
		expect(msgs[2].tool_calls).toHaveLength(1);
		expect(msgs[2].tool_calls![0].function.name).toBe('search_vault');
		expect(JSON.parse(msgs[2].tool_calls![0].function.arguments)).toEqual({ query: 'x' });
		expect(msgs[3].role).toBe('tool');
		expect(msgs[3].tool_call_id).toBe('call-1');
		expect(msgs[3].content).toBe('{"matches":0}');
	});

	it('labels a loaded skill custom_message as a user-role context message', async () => {
		const user = userText('1', 'q');
		const skill: CustomMessageEntry = {
			type: 'custom_message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			customType: 'skill',
			content: 'SKILL BODY',
			display: 'skill: note-capture',
		};
		const msgs = await renderMessages([user, skill], 'SYS', noImage);
		const last = msgs[msgs.length - 1];
		expect(last.role).toBe('user');
		expect(last.content).toContain('Loaded skill: note-capture');
		expect(last.content).toContain('SKILL BODY');
	});

	it('labels a non-skill custom_message with its customType', async () => {
		const user = userText('1', 'q');
		const note: CustomMessageEntry = {
			type: 'custom_message',
			id: '2',
			parentId: '1',
			timestamp: '2026-05-23T10:00:01.000Z',
			customType: 'agents_md',
			content: 'CONTEXT BODY',
		};
		const msgs = await renderMessages([user, note], 'SYS', noImage);
		const last = msgs[msgs.length - 1];
		expect(last.role).toBe('user');
		expect(last.content).toContain('[agents_md]');
		expect(last.content).toContain('CONTEXT BODY');
	});

	it('flattens a user-role message with only text blocks into a plain string', async () => {
		const u: MessageEntry = {
			type: 'message',
			id: 'u1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'hello ' },
					{ type: 'text', text: 'world' },
				],
			},
		};
		const msgs = await renderMessages([u], 'SYS', noImage);
		expect(msgs[1]).toEqual({ role: 'user', content: 'hello world' });
	});

	it('injects pinnedPreamble in front of the most recent string-content user message', async () => {
		const u1 = userText('1', 'old', null);
		const u2 = userText('2', 'newest', '1');
		const msgs = await renderMessages([u1, u2], 'SYS', noImage, '📌 pinned content');
		expect(msgs[1].content).toBe('old');
		expect(msgs[2].content).toBe('📌 pinned content\n\n---\n\nnewest');
	});

	it('injects pinnedPreamble as a leading text part when the latest user has block content', async () => {
		const u: MessageEntry = {
			type: 'message',
			id: 'u1',
			parentId: null,
			timestamp: '2026-05-23T10:00:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'see attached' },
					{ type: 'image', path: 'attachments/p.jpg', mime: 'image/jpeg' },
				],
			},
		};
		const resolveImage = async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
		const msgs = await renderMessages([u], 'SYS', resolveImage, '📌 pinned');
		const parts = msgs[1].content as Array<{ type: string; text?: string }>;
		expect(parts[0]).toEqual({ type: 'text', text: '📌 pinned\n\n---\n\n' });
		expect(parts[1]).toEqual({ type: 'text', text: 'see attached' });
		expect(parts[2].type).toBe('image_url');
	});
});

describe('openai-compat buildHeaders', () => {
	it('omits Authorization when apiKey is empty so local endpoints (Ollama, LM Studio, oMLX) can send without a key', () => {
		const h = buildHeaders(endpoint({ apiKey: '' }));
		expect(h['Authorization']).toBeUndefined();
		expect(h['Content-Type']).toBe('application/json');
	});

	it('includes Bearer authorization when apiKey is set', () => {
		const h = buildHeaders(endpoint({ apiKey: 'sk-secret' }));
		expect(h['Authorization']).toBe('Bearer sk-secret');
	});

	it('merges endpoint.headers over defaults', () => {
		const h = buildHeaders(endpoint({ apiKey: '', headers: { 'X-Custom': 'v' } }));
		expect(h['X-Custom']).toBe('v');
		expect(h['Authorization']).toBeUndefined();
	});
});

describe('openai-compat toolsToOpenAI', () => {
	it('wraps each tool descriptor as a {type:function, function:{name,description,parameters}} def', () => {
		const out = toolsToOpenAI([
			{ name: 'a', description: 'desc-a', parameters: { type: 'object', properties: {} } },
			{ name: 'b', description: 'desc-b', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
		]);
		expect(out).toEqual([
			{
				type: 'function',
				function: { name: 'a', description: 'desc-a', parameters: { type: 'object', properties: {} } },
			},
			{
				type: 'function',
				function: {
					name: 'b',
					description: 'desc-b',
					parameters: { type: 'object', properties: { x: { type: 'string' } } },
				},
			},
		]);
	});
});
