import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing } from '../src/providers/anthropic';
import type { CustomMessageEntry, Endpoint, MessageEntry } from '../src/types';

const { renderMessages, buildSystem, buildTools, buildHeaders, testConnection } = __testing;

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

/**
 * testConnection is the only provider method that hits the network in two
 * places (— GET /v1/models, then fallback POST /v1/messages), so the tests
 * mock `fetch` and assert the URL each call lands on plus the message the
 * Test row will render.
 */
describe('anthropic testConnection', () => {
	const ep = (overrides: Partial<Endpoint> = {}): Endpoint => ({
		id: 'e1',
		name: 'Anthropic',
		baseURL: 'https://example.test/api',
		apiKey: 'k',
		...overrides,
	});

	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function respond(
		status: number,
		body: unknown,
	): Response {
		const payload = typeof body === 'string' ? body : JSON.stringify(body);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
			text: async () => payload,
		} as unknown as Response;
	}

	it('returns the discovered model count when /v1/models works', async () => {
		fetchMock.mockResolvedValueOnce(
			respond(200, { data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-7' }] }),
		);
		const result = await testConnection(ep());
		expect(result.message).toBe('3 models');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/api/v1/models');
	});

	it('falls back to a /v1/messages probe when /v1/models 404s and reports reachable', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(200, { content: [{ type: 'text', text: '.' }] }));
		const result = await testConnection(ep());
		expect(result.message).toBe('messages endpoint reachable');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][0]).toBe('https://example.test/api/v1/messages');
		const probeOpts = fetchMock.mock.calls[1][1] as RequestInit;
		expect(probeOpts.method).toBe('POST');
		const body = JSON.parse(probeOpts.body as string);
		expect(body.max_tokens).toBe(1);
		expect(body.messages).toEqual([{ role: 'user', content: '.' }]);
	});

	it('treats a non-404 probe failure as URL-ok with the status surfaced (key rejected, model restricted, etc.)', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(401, 'unauthorized'));
		const result = await testConnection(ep());
		expect(result.message).toBe('URL ok (probe returned 401)');
	});

	it('throws HTTP 404 when both /v1/models and /v1/messages 404 (URL is wrong)', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(404, 'no such route'));
		await expect(testConnection(ep())).rejects.toThrow(/HTTP 404/);
	});

	it('propagates non-404 /v1/models errors without falling back (auth and server errors are real)', async () => {
		fetchMock.mockResolvedValueOnce(respond(401, 'bad key'));
		await expect(testConnection(ep())).rejects.toThrow(/HTTP 401/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('uses endpoint.models[0] as the probe slug when /v1/models is unavailable', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(200, {}));
		await testConnection(ep({ models: ['claude-sonnet-4-6', 'claude-opus-4-7'] }));
		const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
		expect(body.model).toBe('claude-sonnet-4-6');
	});

	it('falls back to discoveredModels[0] when models[] is empty', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(200, {}));
		await testConnection(
			ep({ discoveredModels: [{ id: 'claude-from-discovery' }] }),
		);
		const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
		expect(body.model).toBe('claude-from-discovery');
	});

	it('falls back to a hardcoded probe slug when the endpoint has no models at all', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(200, {}));
		await testConnection(ep());
		const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
		expect(body.model).toBe('claude-haiku-4-5');
	});

	it('trims a trailing slash on baseURL before composing /v1/* paths', async () => {
		fetchMock
			.mockResolvedValueOnce(respond(404, 'not found'))
			.mockResolvedValueOnce(respond(200, {}));
		await testConnection(ep({ baseURL: 'https://example.test/api/' }));
		expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/api/v1/models');
		expect(fetchMock.mock.calls[1][0]).toBe('https://example.test/api/v1/messages');
	});
});
