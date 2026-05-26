import { arrayBufferToBase64, dataUrlFor } from '../image-helpers';
import { fetchWithRetry } from './retry';
import { streamSplit } from './sse';
import { assembleStream } from './stream-runner';
import { createThinkStripper, type ThinkStripper } from './think-strip';
import type { DiscoveredModel, Endpoint, Entry, ImageBlock, Role } from '../types';
import type {
	AssembledTurn,
	ImageResolver,
	Provider,
	ProviderCapabilities,
	StreamCallbacks,
	StreamEvent,
	ToolDescriptor,
	TurnRequest,
} from './types';

interface OpenAIToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

type CacheControl = { type: 'ephemeral' };

type OpenAIContentPart =
	| { type: 'text'; text: string; cache_control?: CacheControl }
	| { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

interface OpenAIMessage {
	role: Role;
	content?: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

const CAPABILITIES: ProviderCapabilities = {
	supportsCachedPrompt: false,
};

function buildHeaders(endpoint: Endpoint): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (endpoint.apiKey) headers['Authorization'] = `Bearer ${endpoint.apiKey}`;
	if (endpoint.headers) Object.assign(headers, endpoint.headers);
	if (endpoint.baseURL.includes('openrouter.ai')) {
		headers['HTTP-Referer'] = 'https://github.com/rsperko/smart-aide';
		headers['X-Title'] = 'smart-aide';
	}
	return headers;
}

function trimBase(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toolsToOpenAI(tools: ToolDescriptor[]): OpenAIToolDef[] {
	return tools.map((t) => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}

async function imageBlockToPart(block: ImageBlock, resolveImage: ImageResolver): Promise<OpenAIContentPart> {
	const bytes = await resolveImage(block.path);
	if (!bytes) {
		return { type: 'text', text: `[image not found: ${block.path}]` };
	}
	const base64 = arrayBufferToBase64(bytes);
	return { type: 'image_url', image_url: { url: dataUrlFor(block.mime, base64) } };
}

/**
 * Render the Pi v3 context chain into OpenAI chat-completions message shape.
 * Mirrors the previous storage.toOpenAIMessages so behavior is unchanged.
 */
async function renderMessages(
	chain: Entry[],
	systemPrompt: string,
	resolveImage: ImageResolver,
	pinnedPreamble?: string,
): Promise<OpenAIMessage[]> {
	const messages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];
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
			messages.push({ role: 'user', content: `${label}\n\n${entry.content}` });
			continue;
		}
		if (entry.type !== 'message') continue;
		const m = entry.message;
		if (typeof m.content === 'string') {
			messages.push({ role: m.role, content: m.content });
			continue;
		}
		if (m.role === 'assistant') {
			const textParts: string[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			for (const block of m.content) {
				if (block.type === 'text') textParts.push(block.text);
				else if (block.type === 'toolCall')
					toolCalls.push({
						id: block.id,
						type: 'function',
						function: { name: block.name, arguments: JSON.stringify(block.arguments) },
					});
			}
			messages.push({
				role: 'assistant',
				content: textParts.join('') || null,
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			});
		} else if (m.role === 'tool') {
			for (const block of m.content) {
				if (block.type === 'toolResult') {
					messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: block.content });
				}
			}
		} else {
			const hasImage = m.content.some((b) => b.type === 'image');
			const parts: OpenAIContentPart[] = [];
			for (const block of m.content) {
				if (block.type === 'text') parts.push({ type: 'text', text: block.text });
				else if (block.type === 'image') parts.push(await imageBlockToPart(block, resolveImage));
			}
			messages.push({
				role: m.role,
				content: hasImage
					? parts
					: parts.map((p) => (p as { type: 'text'; text: string }).text).join(''),
			});
		}
	}

	if (pinnedPreamble) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== 'user') continue;
			if (typeof m.content === 'string') {
				m.content = `${pinnedPreamble}\n\n---\n\n${m.content}`;
				break;
			}
			if (Array.isArray(m.content)) {
				m.content = [{ type: 'text', text: `${pinnedPreamble}\n\n---\n\n` }, ...m.content];
				break;
			}
		}
	}

	return messages;
}

/**
 * Heuristic: is this OpenAI-compat slug going to be routed to a Claude model
 * by the upstream gateway (OpenRouter, AWS Bedrock proxy, etc.)? If so, the
 * gateway will forward Anthropic `cache_control` markers — adding them is a
 * 90% cost reduction on cached tokens for long-running chats. For non-Claude
 * routes, sending the field is unsafe (OpenAI direct rejects it), so we gate.
 */
export function isClaudeBackedModel(slug: string): boolean {
	return /(?:^|\/)claude/i.test(slug) || /^anthropic\//i.test(slug);
}

/**
 * Add Anthropic `cache_control` to the system message when the route is
 * Claude-backed. One breakpoint on the last system text part covers the whole
 * system prefix. No-op for non-Claude routes or when caching is disabled.
 */
export function applyClaudeCacheBreakpoints(
	messages: OpenAIMessage[],
	model: string,
	enable: boolean,
): OpenAIMessage[] {
	if (!enable || !isClaudeBackedModel(model)) return messages;
	const out = messages.map((m) => ({ ...m }));
	const sysIdx = out.findIndex((m) => m.role === 'system');
	if (sysIdx < 0) return out;
	const sys = out[sysIdx];
	if (typeof sys.content === 'string') {
		out[sysIdx] = {
			...sys,
			content: [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }],
		};
	} else if (Array.isArray(sys.content) && sys.content.length > 0) {
		const parts = sys.content.map((p) => ({ ...p }));
		const lastText = [...parts].reverse().find((p) => p.type === 'text');
		if (lastText) {
			(lastText as { cache_control?: CacheControl }).cache_control = { type: 'ephemeral' };
		}
		out[sysIdx] = { ...sys, content: parts };
	}
	return out;
}

/**
 * Convert one parsed OpenAI-compat SSE chunk into provider-neutral StreamEvents.
 *
 * Reasoning handling:
 * - `delta.content` runs through the think-stripper so `<think>...</think>`
 *   blocks emitted inline (Qwen-thinking, Ollama gpt-oss, DeepSeek-V3 with
 *   thinking enabled, etc.) do not leak into the rendered assistant text or
 *   the persisted assistant message (which would be re-sent next turn and
 *   trigger provider 400s on some endpoints).
 * - `delta.reasoning_content` (DeepSeek native) and `delta.reasoning`
 *   (OpenRouter normalized form for o1, R1, Qwen-thinking via the router) are
 *   silently dropped. We never echo them back on the next turn — DeepSeek
 *   explicitly says reasoning content must not be re-sent.
 */
export function eventsFromOpenAIChunk(chunk: any, stripper: ThinkStripper): StreamEvent[] {
	const events: StreamEvent[] = [];

	if (chunk.usage) {
		events.push({
			type: 'usage',
			usage: {
				promptTokens: chunk.usage.prompt_tokens ?? 0,
				completionTokens: chunk.usage.completion_tokens ?? 0,
				cachedReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
			},
		});
	}

	const choice = chunk.choices?.[0];
	if (!choice) return events;

	const delta = choice.delta;
	if (typeof delta?.content === 'string' && delta.content.length > 0) {
		const { visible } = stripper.push(delta.content);
		if (visible) events.push({ type: 'text-delta', textDelta: visible });
	}

	if (delta?.tool_calls) {
		for (const tc of delta.tool_calls) {
			events.push({
				type: 'tool-call-delta',
				toolCallDelta: {
					index: tc.index ?? 0,
					id: tc.id,
					name: tc.function?.name,
					argumentsDelta: tc.function?.arguments,
				},
			});
		}
	}

	if (choice.finish_reason) {
		events.push({ type: 'finish', finishReason: choice.finish_reason });
	}

	return events;
}

/**
 * End-of-stream flush. A residual partial open tag (e.g. `<thi` with no closing
 * `<think>` ever arriving) is emitted as visible text — better to render the
 * literal characters than silently swallow them. A residual unclosed reasoning
 * block is dropped (treating it as reasoning, consistent with the rest of the
 * pipeline).
 */
export function flushStripperEvents(stripper: ThinkStripper): StreamEvent[] {
	const { visible } = stripper.flush();
	if (!visible) return [];
	return [{ type: 'text-delta', textDelta: visible }];
}

async function* streamTurn(req: TurnRequest, resolveImage: ImageResolver): AsyncGenerator<StreamEvent> {
	const rendered = await renderMessages(req.chain, req.systemPrompt, resolveImage, req.pinnedPreamble);
	const messages = applyClaudeCacheBreakpoints(rendered, req.model, req.enablePromptCaching ?? false);
	const tools = toolsToOpenAI(req.tools);
	const url = `${trimBase(req.endpoint.baseURL)}/chat/completions`;
	const res = await fetchWithRetry(url, {
		method: 'POST',
		headers: buildHeaders(req.endpoint),
		body: JSON.stringify({
			model: req.model,
			messages,
			tools: tools.length ? tools : undefined,
			stream: true,
			stream_options: { include_usage: true },
		}),
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

	const stripper = createThinkStripper();
	for await (const raw of streamSplit(res.body, '\n')) {
		const line = raw.trim();
		if (!line || !line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (data === '[DONE]') break;

		let chunk: any;
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}

		for (const ev of eventsFromOpenAIChunk(chunk, stripper)) yield ev;
	}
	for (const ev of flushStripperEvents(stripper)) yield ev;
}

function runTurn(
	req: TurnRequest,
	resolveImage: ImageResolver,
	cb?: StreamCallbacks,
): Promise<AssembledTurn> {
	return assembleStream(streamTurn, req, resolveImage, cb);
}

async function discoverModels(endpoint: Endpoint, signal?: AbortSignal): Promise<DiscoveredModel[]> {
	const url = `${trimBase(endpoint.baseURL)}/models`;
	const res = await fetch(url, {
		method: 'GET',
		headers: buildHeaders(endpoint),
		signal,
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const json = (await res.json()) as { data?: unknown[]; models?: unknown[] };
	const list = (json.data ?? json.models ?? []) as Array<Record<string, any>>;
	return list
		.map((m): DiscoveredModel => {
			const promptRaw = m.pricing?.prompt ?? m.pricing?.input;
			const completionRaw = m.pricing?.completion ?? m.pricing?.output;
			const supportsTools =
				m.supports_tools ??
				m.supports_function_calling ??
				(Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined);
			return {
				id: String(m.id ?? m.name ?? ''),
				name: typeof m.name === 'string' ? m.name : undefined,
				contextLength: numberOrUndef(m.context_length ?? m.context_window ?? m.top_provider?.context_length),
				promptPrice: priceToPerMillion(promptRaw),
				completionPrice: priceToPerMillion(completionRaw),
				supportsTools: typeof supportsTools === 'boolean' ? supportsTools : undefined,
			};
		})
		.filter((m) => m.id);
}

function numberOrUndef(v: unknown): number | undefined {
	const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
	return Number.isFinite(n) ? n : undefined;
}

function priceToPerMillion(v: unknown): number | undefined {
	const n = numberOrUndef(v);
	if (n === undefined) return undefined;
	if (n === 0) return 0;
	// OpenRouter returns per-token (e.g. 0.0000008); some endpoints return per-1M directly.
	// Heuristic: anything < 0.1 is per-token, scale by 1e6.
	return n < 0.1 ? n * 1_000_000 : n;
}

export const openAICompatProvider: Provider = {
	capabilities: CAPABILITIES,
	streamTurn,
	runTurn,
	discoverModels,
};

/** Exported for tests — renders a Pi chain into OpenAI-shape messages. */
export const __testing = {
	renderMessages,
	toolsToOpenAI,
	buildHeaders,
	applyClaudeCacheBreakpoints,
	isClaudeBackedModel,
	eventsFromOpenAIChunk,
	flushStripperEvents,
};
