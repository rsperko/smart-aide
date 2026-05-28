import { arrayBufferToBase64 } from '../image-helpers';
import { fetchWithRetry } from './retry';
import { streamSplit } from './sse';
import { assembleStream } from './stream-runner';
import type { DiscoveredModel, Endpoint, Entry, ImageBlock } from '../types';
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

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const CAPABILITIES: ProviderCapabilities = {
	// Gemini 2.5 Flash/Pro do implicit prompt caching automatically; the usage
	// payload reports cachedContentTokenCount. No explicit cache plumbing needed.
	supportsCachedPrompt: true,
};

type TextPart = { text: string };
type InlineDataPart = { inlineData: { mimeType: string; data: string } };
type FunctionCallPart = { functionCall: { name: string; args: Record<string, unknown> } };
type FunctionResponsePart = { functionResponse: { name: string; response: Record<string, unknown> } };

type Part = TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart;

interface GeminiContent {
	role: 'user' | 'model';
	parts: Part[];
}

interface GeminiToolFunctionDecl {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

function trimBase(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildHeaders(endpoint: Endpoint): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (endpoint.apiKey) headers['x-goog-api-key'] = endpoint.apiKey;
	if (endpoint.headers) Object.assign(headers, endpoint.headers);
	return headers;
}

async function imageBlockToPart(block: ImageBlock, resolveImage: ImageResolver): Promise<Part> {
	const bytes = await resolveImage(block.path);
	if (!bytes) {
		return { text: `[image not found: ${block.path}]` };
	}
	return { inlineData: { mimeType: block.mime, data: arrayBufferToBase64(bytes) } };
}

/**
 * Parse a tool-result `content` string into the object Gemini expects. Most of
 * our tools return JSON strings; we pass the parsed object through. Falls back
 * to wrapping the raw text under a `result` key when parsing fails.
 */
function toolResultToResponse(content: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(content);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { result: parsed };
	} catch {
		return { result: content };
	}
}

/**
 * Convert the Pi v3 context chain into Gemini's `contents` array.
 *
 * Shape differences:
 * - Roles are `user` and `model` (no `assistant`, no `tool`).
 * - System prompt is a top-level `systemInstruction` parameter, not a content entry.
 * - Tool calls are `functionCall` parts in a `model`-role message (no IDs).
 * - Tool results are `functionResponse` parts in a `user`-role message (matched
 *   by name + position, no IDs).
 * - Images use `inlineData: {mimeType, data}` parts.
 *
 * Pi v3's `toolCallId` is dropped on the wire — we keep an id→name map while
 * walking the chain so `toolResult` blocks (which reference id) can re-emit the
 * original tool name.
 */
async function renderContents(
	chain: Entry[],
	resolveImage: ImageResolver,
	pinnedPreamble?: string,
): Promise<GeminiContent[]> {
	const contents: GeminiContent[] = [];
	const isPureFunctionResponse = new Set<number>();
	const toolNameById = new Map<string, string>();

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
			contents.push({ role: 'user', parts: [{ text: `${label}\n\n${entry.content}` }] });
			continue;
		}
		if (entry.type !== 'message') continue;
		const m = entry.message;

		if (m.role === 'system') {
			const text = typeof m.content === 'string' ? m.content : '';
			if (text) contents.push({ role: 'user', parts: [{ text: `[system]\n\n${text}` }] });
			continue;
		}

		if (m.role === 'tool') {
			const parts: Part[] = [];
			if (Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block.type === 'toolResult') {
						const name = toolNameById.get(block.toolCallId) ?? 'unknown_tool';
						parts.push({
							functionResponse: { name, response: toolResultToResponse(block.content) },
						});
					}
				}
			}
			if (parts.length) {
				isPureFunctionResponse.add(contents.length);
				contents.push({ role: 'user', parts });
			}
			continue;
		}

		if (m.role === 'assistant') {
			const parts: Part[] = [];
			if (typeof m.content === 'string') {
				if (m.content) parts.push({ text: m.content });
			} else {
				for (const block of m.content) {
					if (block.type === 'text') parts.push({ text: block.text });
					else if (block.type === 'toolCall') {
						toolNameById.set(block.id, block.name);
						parts.push({
							functionCall: {
								name: block.name,
								args: (block.arguments as Record<string, unknown>) ?? {},
							},
						});
					}
				}
			}
			if (parts.length) contents.push({ role: 'model', parts });
			continue;
		}

		// user role
		if (typeof m.content === 'string') {
			contents.push({ role: 'user', parts: [{ text: m.content }] });
		} else {
			const parts: Part[] = [];
			for (const block of m.content) {
				if (block.type === 'text') parts.push({ text: block.text });
				else if (block.type === 'image') parts.push(await imageBlockToPart(block, resolveImage));
			}
			if (parts.length) contents.push({ role: 'user', parts });
		}
	}

	if (pinnedPreamble) {
		for (let i = contents.length - 1; i >= 0; i--) {
			if (isPureFunctionResponse.has(i)) continue;
			const c = contents[i];
			if (c.role !== 'user') continue;
			c.parts = [{ text: `${pinnedPreamble}\n\n---\n\n` }, ...c.parts];
			break;
		}
	}

	return contents;
}

/**
 * Map Gemini's `usageMetadata` payload into the cross-provider TurnUsage shape.
 * `cachedContentTokenCount` is the implicit-cache hit reported by Gemini 2.5
 * Flash/Pro — surfacing it as `cachedReadTokens` lets the token chip and the
 * cost popover credit the user for the cache without provider-specific code.
 */
export function parseGeminiUsage(
	usageMetadata: Record<string, unknown> | null | undefined,
): { promptTokens: number; completionTokens: number; cachedReadTokens?: number } | null {
	if (!usageMetadata) return null;
	const u = usageMetadata as Record<string, number | undefined>;
	const cached = u.cachedContentTokenCount;
	return {
		promptTokens: u.promptTokenCount ?? 0,
		completionTokens: u.candidatesTokenCount ?? 0,
		cachedReadTokens: cached && cached > 0 ? cached : undefined,
	};
}

function buildTools(tools: ToolDescriptor[]): { functionDeclarations: GeminiToolFunctionDecl[] }[] {
	if (tools.length === 0) return [];
	return [
		{
			functionDeclarations: tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			})),
		},
	];
}

async function* streamTurn(req: TurnRequest, resolveImage: ImageResolver): AsyncGenerator<StreamEvent> {
	const contents = await renderContents(req.chain, resolveImage, req.pinnedPreamble);
	const tools = buildTools(req.tools);

	const body: Record<string, unknown> = {
		contents,
		generationConfig: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
	};
	if (req.systemPrompt) {
		body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
	}
	if (tools.length) body.tools = tools;

	const url = `${trimBase(req.endpoint.baseURL)}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
	const res = await fetchWithRetry(url, {
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

	let nextToolIndex = 0;
	let usage: { promptTokens: number; completionTokens: number; cachedReadTokens?: number } | null = null;
	let finishReason: string | undefined;

	for await (const raw of streamSplit(res.body, '\n')) {
		const line = raw.trim();
		if (!line || !line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (!data) continue;

		let chunk: any;
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}

		const candidate = chunk.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (typeof part.text === 'string' && part.text) {
					yield { type: 'text-delta', textDelta: part.text };
				} else if (part.functionCall) {
					// Gemini doesn't stream args incrementally — the entire call arrives at once.
					// Synthesize an id so downstream (Pi v3, view.ts) can route results back.
					const toolIndex = nextToolIndex++;
					const synthId = `gem_${Date.now().toString(36)}_${toolIndex}`;
					const args = part.functionCall.args ?? {};
					yield {
						type: 'tool-call-delta',
						toolCallDelta: {
							index: toolIndex,
							id: synthId,
							name: part.functionCall.name,
							argumentsDelta: JSON.stringify(args),
						},
					};
				}
			}
		}
		if (candidate?.finishReason) {
			finishReason = candidate.finishReason;
		}

		if (chunk.usageMetadata) {
			usage = parseGeminiUsage(chunk.usageMetadata);
		}
	}

	if (finishReason) {
		yield { type: 'finish', finishReason };
	}
	if (usage) {
		yield { type: 'usage', usage };
	}
}

function runTurn(
	req: TurnRequest,
	resolveImage: ImageResolver,
	cb?: StreamCallbacks,
): Promise<AssembledTurn> {
	return assembleStream(streamTurn, req, resolveImage, cb, { defaultToolArguments: '{}' });
}

async function discoverModels(endpoint: Endpoint, signal?: AbortSignal): Promise<DiscoveredModel[]> {
	const url = `${trimBase(endpoint.baseURL)}/v1beta/models`;
	const res = await fetch(url, {
		method: 'GET',
		headers: buildHeaders(endpoint),
		signal,
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const json = (await res.json()) as { models?: Array<Record<string, unknown>> };
	const list = json.models ?? [];
	return list
		.map((m): DiscoveredModel | null => {
			const rawName = String(m.name ?? '');
			const id = rawName.startsWith('models/') ? rawName.slice(7) : rawName;
			if (!id) return null;
			const methods = Array.isArray(m.supportedGenerationMethods)
				? (m.supportedGenerationMethods as string[])
				: [];
			// Skip models that don't support generateContent (embeddings, etc.).
			if (methods.length > 0 && !methods.includes('generateContent')) return null;
			const inputTokenLimit = typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined;
			return {
				id,
				name: typeof m.displayName === 'string' ? m.displayName : undefined,
				contextLength: inputTokenLimit,
				// Gemini /models doesn't surface pricing; leave undefined so the token chip hides cost.
				supportsTools: true,
				supportsImages: true,
			};
		})
		.filter((m): m is DiscoveredModel => m !== null);
}

export const geminiProvider: Provider = {
	capabilities: CAPABILITIES,
	streamTurn,
	runTurn,
	discoverModels,
};

/** Exported for tests — wire-shape conversion helpers. */
export const __testing = {
	renderContents,
	buildTools,
	toolResultToResponse,
	buildHeaders,
	parseGeminiUsage,
};
