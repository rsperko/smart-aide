import { arrayBufferToBase64, dataUrlFor } from '../image-helpers';
import { streamSplit } from './sse';
import { assembleStream } from './stream-runner';
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

type OpenAIContentPart =
	| { type: 'text'; text: string }
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

async function* streamTurn(req: TurnRequest, resolveImage: ImageResolver): AsyncGenerator<StreamEvent> {
	const messages = await renderMessages(req.chain, req.systemPrompt, resolveImage, req.pinnedPreamble);
	const tools = toolsToOpenAI(req.tools);
	const url = `${trimBase(req.endpoint.baseURL)}/chat/completions`;
	const res = await fetch(url, {
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

	for await (const raw of streamSplit(res.body, '\n')) {
		const line = raw.trim();
		if (!line || !line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (data === '[DONE]') return;

		let chunk: any;
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}

		if (chunk.usage) {
			yield {
				type: 'usage',
				usage: {
					promptTokens: chunk.usage.prompt_tokens ?? 0,
					completionTokens: chunk.usage.completion_tokens ?? 0,
					cachedReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
				},
			};
		}

		const choice = chunk.choices?.[0];
		if (!choice) continue;

		const delta = choice.delta;
		if (delta?.content) {
			yield { type: 'text-delta', textDelta: delta.content };
		}

		if (delta?.tool_calls) {
			for (const tc of delta.tool_calls) {
				yield {
					type: 'tool-call-delta',
					toolCallDelta: {
						index: tc.index ?? 0,
						id: tc.id,
						name: tc.function?.name,
						argumentsDelta: tc.function?.arguments,
					},
				};
			}
		}

		if (choice.finish_reason) {
			yield { type: 'finish', finishReason: choice.finish_reason };
		}
	}
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
};
