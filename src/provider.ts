import { DiscoveredModel, Endpoint, OpenAIMessage, OpenAIToolCall, OpenAIToolDef } from './types';

export interface StreamRequest {
	endpoint: Endpoint;
	model: string;
	messages: OpenAIMessage[];
	tools?: OpenAIToolDef[];
	signal?: AbortSignal;
}

export interface StreamEvent {
	type: 'text-delta' | 'tool-call-delta' | 'finish' | 'usage' | 'error';
	textDelta?: string;
	toolCallDelta?: {
		index: number;
		id?: string;
		name?: string;
		argumentsDelta?: string;
	};
	finishReason?: string;
	usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
	error?: string;
}

export interface AssembledTurn {
	text: string;
	toolCalls: OpenAIToolCall[];
	finishReason: string;
	usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
}

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

/**
 * Stream a chat completion from any OpenAI-compatible endpoint. Yields events
 * as they arrive; caller assembles the final turn for persistence.
 */
export async function* streamChat(req: StreamRequest): AsyncGenerator<StreamEvent> {
	const url = `${trimBase(req.endpoint.baseURL)}/chat/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: buildHeaders(req.endpoint),
		body: JSON.stringify({
			model: req.model,
			messages: req.messages,
			tools: req.tools,
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

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const raw of lines) {
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
						cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
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
}

/**
 * Drive streamChat and assemble the full turn (text + tool_calls).
 * Optional onText/onToolCallProgress callbacks let the UI render incrementally.
 */
export async function runTurn(
	req: StreamRequest,
	cb?: {
		onText?: (delta: string) => void;
		onToolCallProgress?: (index: number, partial: { id?: string; name?: string; argsAccum: string }) => void;
		onUsage?: (u: { promptTokens: number; completionTokens: number; cachedTokens?: number }) => void;
	},
): Promise<AssembledTurn> {
	let text = '';
	const toolAccum: Map<number, { id: string; name: string; args: string }> = new Map();
	let finishReason = 'stop';
	let usage: AssembledTurn['usage'] | undefined;

	for await (const ev of streamChat(req)) {
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

	const toolCalls: OpenAIToolCall[] = [...toolAccum.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, v]) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args } }));

	return { text, toolCalls, finishReason, usage };
}

/**
 * Fetch the model catalog from an OpenAI-compatible /models endpoint.
 * Normalizes the response so the picker can read cost + context + tool support uniformly.
 */
export async function discoverModels(endpoint: Endpoint, signal?: AbortSignal): Promise<DiscoveredModel[]> {
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
