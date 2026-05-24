import { arrayBufferToBase64 } from '../image-helpers';
import type { DiscoveredModel, Endpoint, Entry, ImageBlock } from '../types';
import type {
	AssembledTurn,
	ImageResolver,
	Provider,
	ProviderCapabilities,
	StreamCallbacks,
	StreamEvent,
	ToolCall,
	ToolDescriptor,
	TurnRequest,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

const CAPABILITIES: ProviderCapabilities = {
	supportsCachedPrompt: true,
};

type CacheControl = { type: 'ephemeral' };

type SystemBlock = { type: 'text'; text: string; cache_control?: CacheControl };

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };

type ToolResultBlock = {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
};

type UserTextBlock = { type: 'text'; text: string };

type UserImageBlock = {
	type: 'image';
	source: { type: 'base64'; media_type: string; data: string };
};

type AssistantContentBlock = { type: 'text'; text: string } | ToolUseBlock;

type UserContentBlock = UserTextBlock | UserImageBlock | ToolResultBlock;

type AnthropicMessage =
	| { role: 'user'; content: UserContentBlock[] }
	| { role: 'assistant'; content: AssistantContentBlock[] };

interface AnthropicToolDef {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	cache_control?: CacheControl;
}

function trimBase(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildHeaders(endpoint: Endpoint): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': ANTHROPIC_VERSION,
		// Obsidian (Electron / Capacitor) is functionally a browser context.
		// Anthropic requires this header to allow direct calls from a browser.
		'anthropic-dangerous-direct-browser-access': 'true',
	};
	if (endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;
	if (endpoint.headers) Object.assign(headers, endpoint.headers);
	return headers;
}

async function imageBlockToContent(block: ImageBlock, resolveImage: ImageResolver): Promise<UserContentBlock> {
	const bytes = await resolveImage(block.path);
	if (!bytes) {
		return { type: 'text', text: `[image not found: ${block.path}]` };
	}
	return {
		type: 'image',
		source: { type: 'base64', media_type: block.mime, data: arrayBufferToBase64(bytes) },
	};
}

/**
 * Convert the Pi v3 context chain into Anthropic's messages array.
 *
 * Shape differences from OpenAI-compat:
 * - System prompt is a top-level parameter, not a role:'system' message.
 * - Assistant tool calls are content blocks `{type:'tool_use'}` inside the
 *   assistant message — not a sidecar `tool_calls` array.
 * - Tool results live as `{type:'tool_result'}` content blocks inside a USER
 *   message (Anthropic has no `role:'tool'`).
 * - Images use `{source:{type:'base64',media_type,data}}` not data URLs.
 *
 * Pinned preamble is injected into the most recent USER-TEXT message
 * (not a tool-result-only synthetic user message).
 */
async function renderMessages(
	chain: Entry[],
	resolveImage: ImageResolver,
	pinnedPreamble?: string,
): Promise<AnthropicMessage[]> {
	const messages: AnthropicMessage[] = [];

	// Tool-result message tracks indices of pure-tool_result user messages so
	// the pinned-preamble injection can skip them.
	const isPureToolResults = new Set<number>();

	for (const entry of chain) {
		if (entry.type === 'custom_message') {
			let label: string;
			if (entry.customType === 'skill') {
				const skillName = entry.display?.replace(/^skill:\s*/i, '').trim() || 'skill';
				label = `[Loaded skill: ${skillName}]\nFollow these instructions for this turn:`;
			} else if (entry.customType === 'skill-invocation') {
				const skillName = entry.display?.trim() || 'skill';
				label = `[Invoked skill: ${skillName}]\nFollow these instructions for this turn:`;
			} else {
				label = `[${entry.customType}]`;
			}
			messages.push({
				role: 'user',
				content: [{ type: 'text', text: `${label}\n\n${entry.content}` }],
			});
			continue;
		}
		if (entry.type !== 'message') continue;
		const m = entry.message;

		if (m.role === 'system') {
			// System role inside chain entries shouldn't happen, but if it does,
			// fold it into a user note so the model still sees the content.
			const text = typeof m.content === 'string' ? m.content : '';
			if (text) messages.push({ role: 'user', content: [{ type: 'text', text: `[system]\n\n${text}` }] });
			continue;
		}

		if (m.role === 'tool') {
			const blocks: UserContentBlock[] = [];
			if (Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block.type === 'toolResult') {
						blocks.push({
							type: 'tool_result',
							tool_use_id: block.toolCallId,
							content: block.content,
							...(block.isError ? { is_error: true } : {}),
						});
					}
				}
			}
			if (blocks.length) {
				isPureToolResults.add(messages.length);
				messages.push({ role: 'user', content: blocks });
			}
			continue;
		}

		if (m.role === 'assistant') {
			const blocks: AssistantContentBlock[] = [];
			if (typeof m.content === 'string') {
				if (m.content) blocks.push({ type: 'text', text: m.content });
			} else {
				for (const block of m.content) {
					if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
					else if (block.type === 'toolCall')
						blocks.push({
							type: 'tool_use',
							id: block.id,
							name: block.name,
							input: block.arguments,
						});
				}
			}
			if (blocks.length) messages.push({ role: 'assistant', content: blocks });
			continue;
		}

		// user role
		if (typeof m.content === 'string') {
			messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
		} else {
			const blocks: UserContentBlock[] = [];
			for (const block of m.content) {
				if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
				else if (block.type === 'image') blocks.push(await imageBlockToContent(block, resolveImage));
			}
			if (blocks.length) messages.push({ role: 'user', content: blocks });
		}
	}

	if (pinnedPreamble) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (isPureToolResults.has(i)) continue;
			const msg = messages[i];
			if (msg.role !== 'user') continue;
			msg.content = [{ type: 'text', text: `${pinnedPreamble}\n\n---\n\n` }, ...msg.content];
			break;
		}
	}

	return messages;
}

function buildSystem(systemPrompt: string, enableCaching: boolean): string | SystemBlock[] {
	if (!systemPrompt) return systemPrompt;
	if (!enableCaching) return systemPrompt;
	return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

function buildTools(tools: ToolDescriptor[], enableCaching: boolean): AnthropicToolDef[] {
	const out: AnthropicToolDef[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}));
	if (enableCaching && out.length > 0) {
		// One breakpoint on the last tool covers the entire tools + system block.
		out[out.length - 1].cache_control = { type: 'ephemeral' };
	}
	return out;
}

async function* streamTurn(req: TurnRequest, resolveImage: ImageResolver): AsyncGenerator<StreamEvent> {
	const messages = await renderMessages(req.chain, resolveImage, req.pinnedPreamble);
	const enableCaching = req.enablePromptCaching ?? false;
	const system = buildSystem(req.systemPrompt, enableCaching);
	const tools = buildTools(req.tools, enableCaching);

	const body: Record<string, unknown> = {
		model: req.model,
		max_tokens: DEFAULT_MAX_TOKENS,
		messages,
		stream: true,
	};
	if (system) body.system = system;
	if (tools.length) body.tools = tools;

	const url = `${trimBase(req.endpoint.baseURL)}/v1/messages`;
	const res = await fetch(url, {
		method: 'POST',
		headers: buildHeaders(req.endpoint),
		body: JSON.stringify(body),
		signal: req.signal,
	});

	if (!res.ok) {
		const text = await res.text();
		yield { type: 'error', error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
		return;
	}
	if (!res.body) {
		yield { type: 'error', error: 'no response body' };
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	// Per content-block tracking. Anthropic emits events keyed by block index;
	// we map tool-use blocks to a stable tool-call index so the caller's
	// accumulator (one entry per index) matches our flow.
	const toolIndexByBlock = new Map<number, number>();
	let nextToolIndex = 0;
	// Carry usage across message_start (prompt + cache) and message_delta (output).
	let promptTokens = 0;
	let cachedReadTokens = 0;
	let cachedWriteTokens = 0;
	let completionTokens = 0;
	let usageSeen = false;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const parts = buffer.split('\n\n');
		buffer = parts.pop() || '';

		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed) continue;

			let eventName = '';
			let dataStr = '';
			for (const line of trimmed.split('\n')) {
				if (line.startsWith('event:')) eventName = line.slice(6).trim();
				else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
			}
			if (!dataStr) continue;

			let data: any;
			try {
				data = JSON.parse(dataStr);
			} catch {
				continue;
			}

			const type = eventName || data.type;

			if (type === 'message_start' && data.message?.usage) {
				const u = data.message.usage;
				promptTokens = u.input_tokens ?? 0;
				cachedReadTokens = u.cache_read_input_tokens ?? 0;
				cachedWriteTokens = u.cache_creation_input_tokens ?? 0;
				completionTokens = u.output_tokens ?? 0;
				usageSeen = true;
			} else if (type === 'content_block_start') {
				const idx = data.index ?? 0;
				const block = data.content_block;
				if (block?.type === 'tool_use') {
					const toolIndex = nextToolIndex++;
					toolIndexByBlock.set(idx, toolIndex);
					yield {
						type: 'tool-call-delta',
						toolCallDelta: {
							index: toolIndex,
							id: block.id,
							name: block.name,
							argumentsDelta: '',
						},
					};
				}
			} else if (type === 'content_block_delta') {
				const idx = data.index ?? 0;
				const delta = data.delta;
				if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
					yield { type: 'text-delta', textDelta: delta.text };
				} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
					const toolIndex = toolIndexByBlock.get(idx);
					if (toolIndex !== undefined) {
						yield {
							type: 'tool-call-delta',
							toolCallDelta: { index: toolIndex, argumentsDelta: delta.partial_json },
						};
					}
				}
			} else if (type === 'message_delta') {
				if (data.usage?.output_tokens !== undefined) {
					completionTokens = data.usage.output_tokens;
					usageSeen = true;
				}
				if (data.delta?.stop_reason) {
					yield { type: 'finish', finishReason: data.delta.stop_reason };
				}
			} else if (type === 'message_stop') {
				if (usageSeen) {
					yield {
						type: 'usage',
						usage: {
							promptTokens,
							completionTokens,
							cachedReadTokens: cachedReadTokens || undefined,
							cachedWriteTokens: cachedWriteTokens || undefined,
						},
					};
				}
				return;
			} else if (type === 'error') {
				yield { type: 'error', error: data.error?.message || 'anthropic stream error' };
				return;
			}
		}
	}
}

async function runTurn(
	req: TurnRequest,
	resolveImage: ImageResolver,
	cb?: StreamCallbacks,
): Promise<AssembledTurn> {
	let text = '';
	const toolAccum: Map<number, { id: string; name: string; args: string }> = new Map();
	let finishReason = 'stop';
	let usage: AssembledTurn['usage'] | undefined;

	for await (const ev of streamTurn(req, resolveImage)) {
		if (ev.type === 'text-delta' && ev.textDelta) {
			text += ev.textDelta;
			cb?.onText?.(ev.textDelta);
		} else if (ev.type === 'tool-call-delta' && ev.toolCallDelta) {
			const { index, id, name, argumentsDelta } = ev.toolCallDelta;
			const cur = toolAccum.get(index) ?? { id: '', name: '', args: '' };
			if (id) cur.id = id;
			if (name) cur.name = name;
			if (argumentsDelta) cur.args += argumentsDelta;
			toolAccum.set(index, cur);
			cb?.onToolCallProgress?.(index, { id: cur.id, name: cur.name, argsAccum: cur.args });
		} else if (ev.type === 'usage' && ev.usage) {
			usage = ev.usage;
			cb?.onUsage?.(ev.usage);
		} else if (ev.type === 'finish' && ev.finishReason) {
			finishReason = ev.finishReason;
		} else if (ev.type === 'error') {
			throw new Error(ev.error || 'stream error');
		}
	}

	const toolCalls: ToolCall[] = [...toolAccum.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args || '{}' }));

	return { text, toolCalls, finishReason, usage };
}

async function discoverModels(endpoint: Endpoint, signal?: AbortSignal): Promise<DiscoveredModel[]> {
	const url = `${trimBase(endpoint.baseURL)}/v1/models`;
	const res = await fetch(url, {
		method: 'GET',
		headers: buildHeaders(endpoint),
		signal,
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
	const list = json.data ?? [];
	// Anthropic doesn't return pricing or context length here — leave them
	// undefined; the token chip already hides cost when unknown.
	return list
		.map((m): DiscoveredModel => ({
			id: String(m.id ?? ''),
			name: typeof m.display_name === 'string' ? m.display_name : undefined,
			supportsTools: true,
		}))
		.filter((m) => m.id);
}

export const anthropicProvider: Provider = {
	capabilities: CAPABILITIES,
	streamTurn,
	runTurn,
	discoverModels,
};

/** Exported for tests — wire-shape conversion helpers. */
export const __testing = {
	renderMessages,
	buildSystem,
	buildTools,
};
