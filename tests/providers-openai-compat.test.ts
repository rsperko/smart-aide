import { describe, expect, it } from 'vitest';
import { __testing } from '../src/providers/openai-compat';
import { createThinkStripper } from '../src/providers/think-strip';
import type { Entry, MessageEntry, CustomMessageEntry } from '../src/types';

const {
	renderMessages,
	toolsToOpenAI,
	buildHeaders,
	applyClaudeCacheBreakpoints,
	isClaudeBackedModel,
	eventsFromOpenAIChunk,
	flushStripperEvents,
} = __testing;

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

describe('isClaudeBackedModel', () => {
	it('matches OpenRouter-style anthropic/claude-* slugs', () => {
		expect(isClaudeBackedModel('anthropic/claude-haiku-4.5')).toBe(true);
		expect(isClaudeBackedModel('anthropic/claude-opus-4.7')).toBe(true);
	});

	it('matches bare claude-* slugs', () => {
		expect(isClaudeBackedModel('claude-3-5-sonnet')).toBe(true);
		expect(isClaudeBackedModel('claude-opus-4-7')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isClaudeBackedModel('Anthropic/Claude-Opus-4.7')).toBe(true);
	});

	it('does NOT match OpenAI, Gemini, or other models', () => {
		expect(isClaudeBackedModel('gpt-4o')).toBe(false);
		expect(isClaudeBackedModel('openai/gpt-4o')).toBe(false);
		expect(isClaudeBackedModel('google/gemini-2.5-pro')).toBe(false);
		expect(isClaudeBackedModel('mistralai/mixtral-8x7b')).toBe(false);
		expect(isClaudeBackedModel('llama-3.1-70b')).toBe(false);
	});
});

describe('applyClaudeCacheBreakpoints', () => {
	const baseMessages = () => [
		{ role: 'system' as const, content: 'YOU ARE A HELPFUL ASSISTANT' },
		{ role: 'user' as const, content: 'hello' },
	];

	it('returns messages unchanged when caching is disabled', () => {
		const msgs = baseMessages();
		const out = applyClaudeCacheBreakpoints(msgs, 'anthropic/claude-haiku-4.5', false);
		expect(out).toEqual(msgs);
	});

	it('returns messages unchanged for non-Claude models even with caching enabled', () => {
		const msgs = baseMessages();
		const out = applyClaudeCacheBreakpoints(msgs, 'openai/gpt-4o', true);
		expect(out).toEqual(msgs);
	});

	it('converts the system string content to a content array with cache_control on Claude routes', () => {
		const msgs = baseMessages();
		const out = applyClaudeCacheBreakpoints(msgs, 'anthropic/claude-haiku-4.5', true);
		const sys = out[0];
		expect(sys.role).toBe('system');
		expect(Array.isArray(sys.content)).toBe(true);
		const parts = sys.content as Array<{ type: string; text: string; cache_control?: unknown }>;
		expect(parts[0].type).toBe('text');
		expect(parts[0].text).toBe('YOU ARE A HELPFUL ASSISTANT');
		expect(parts[0].cache_control).toEqual({ type: 'ephemeral' });
	});

	it('does not mutate the input messages array', () => {
		const msgs = baseMessages();
		const snapshot = JSON.parse(JSON.stringify(msgs));
		applyClaudeCacheBreakpoints(msgs, 'anthropic/claude-haiku-4.5', true);
		expect(msgs).toEqual(snapshot);
	});

	it('leaves a system message that is already an array shape intact and tags its last part', () => {
		const msgs = [
			{
				role: 'system' as const,
				content: [
					{ type: 'text' as const, text: 'PART A' },
					{ type: 'text' as const, text: 'PART B' },
				],
			},
		];
		const out = applyClaudeCacheBreakpoints(msgs, 'anthropic/claude-haiku-4.5', true);
		const parts = out[0].content as Array<{ type: string; text: string; cache_control?: unknown }>;
		expect(parts).toHaveLength(2);
		expect(parts[0].cache_control).toBeUndefined();
		expect(parts[1].cache_control).toEqual({ type: 'ephemeral' });
	});

	it('is a no-op when the message list has no system message', () => {
		const msgs = [{ role: 'user' as const, content: 'hi' }];
		const out = applyClaudeCacheBreakpoints(msgs, 'anthropic/claude-haiku-4.5', true);
		expect(out).toEqual(msgs);
	});
});

describe('eventsFromOpenAIChunk', () => {
	it('emits text-delta for plain content', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk({ choices: [{ delta: { content: 'hello' } }] }, s);
		expect(out).toEqual([{ type: 'text-delta', textDelta: 'hello' }]);
	});

	it('strips <think>...</think> blocks from content', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{ choices: [{ delta: { content: 'a<think>hidden</think>b' } }] },
			s,
		);
		expect(out).toEqual([{ type: 'text-delta', textDelta: 'ab' }]);
	});

	it('emits no text-delta when content is entirely within a think block', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{ choices: [{ delta: { content: '<think>just reasoning' } }] },
			s,
		);
		expect(out).toEqual([]);
	});

	it('drops delta.reasoning_content silently (DeepSeek native channel)', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{ choices: [{ delta: { reasoning_content: 'this is internal' } }] },
			s,
		);
		expect(out).toEqual([]);
	});

	it('drops delta.reasoning silently (OpenRouter normalized form)', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{ choices: [{ delta: { reasoning: 'router reasoning' } }] },
			s,
		);
		expect(out).toEqual([]);
	});

	it('still emits text-delta when content coexists with reasoning_content', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{ choices: [{ delta: { content: 'visible', reasoning_content: 'hidden' } }] },
			s,
		);
		expect(out).toEqual([{ type: 'text-delta', textDelta: 'visible' }]);
	});

	it('emits tool-call-delta for tool_calls', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: 'c1', function: { name: 'foo', arguments: '{"x":1}' } },
							],
						},
					},
				],
			},
			s,
		);
		expect(out).toEqual([
			{
				type: 'tool-call-delta',
				toolCallDelta: { index: 0, id: 'c1', name: 'foo', argumentsDelta: '{"x":1}' },
			},
		]);
	});

	it('emits usage for chunks carrying usage info', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk(
			{
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					prompt_tokens_details: { cached_tokens: 30 },
				},
			},
			s,
		);
		expect(out).toEqual([
			{
				type: 'usage',
				usage: { promptTokens: 100, completionTokens: 50, cachedReadTokens: 30 },
			},
		]);
	});

	it('emits finish_reason as a finish event', () => {
		const s = createThinkStripper();
		const out = eventsFromOpenAIChunk({ choices: [{ finish_reason: 'stop' }] }, s);
		expect(out).toEqual([{ type: 'finish', finishReason: 'stop' }]);
	});

	it('reassembles think tags that span multiple chunks', () => {
		const s = createThinkStripper();
		const c1 = eventsFromOpenAIChunk({ choices: [{ delta: { content: 'a<thi' } }] }, s);
		const c2 = eventsFromOpenAIChunk(
			{ choices: [{ delta: { content: 'nk>hidden</think>b' } }] },
			s,
		);
		const visible = [...c1, ...c2]
			.filter((e): e is { type: 'text-delta'; textDelta: string } => e.type === 'text-delta')
			.map((e) => e.textDelta)
			.join('');
		expect(visible).toBe('ab');
	});
});

describe('flushStripperEvents', () => {
	it('emits a final text-delta for a residual partial open tag (treated as visible)', () => {
		const s = createThinkStripper();
		eventsFromOpenAIChunk({ choices: [{ delta: { content: 'keep<thi' } }] }, s);
		const out = flushStripperEvents(s);
		expect(out).toEqual([{ type: 'text-delta', textDelta: '<thi' }]);
	});

	it('emits nothing when the stripper has no residual buffer', () => {
		const s = createThinkStripper();
		eventsFromOpenAIChunk({ choices: [{ delta: { content: 'all done' } }] }, s);
		const out = flushStripperEvents(s);
		expect(out).toEqual([]);
	});

	it('drops residual reasoning (unclosed think block at end-of-stream)', () => {
		const s = createThinkStripper();
		eventsFromOpenAIChunk({ choices: [{ delta: { content: '<think>truncated' } }] }, s);
		const out = flushStripperEvents(s);
		expect(out).toEqual([]);
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
