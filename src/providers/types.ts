import type { DiscoveredModel, Endpoint, Entry, Tool } from '../types';

/** Provider-neutral tool call. Arguments are kept as a raw JSON string because
 * streaming accumulates them incrementally; the caller parses when ready. */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

/** Provider-neutral tool descriptor. Anthropic and OpenAI both accept JSON
 * Schema for parameters — the wire wrapping (`{type:'function', function:{…}}`
 * vs `{input_schema:{…}}`) is the provider's job. */
export interface ToolDescriptor {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface TurnUsage {
	promptTokens: number;
	completionTokens: number;
	/** Tokens read from a previously-written cache entry (Anthropic split). */
	cachedReadTokens?: number;
	/** Tokens written into a new cache entry on this turn (Anthropic split). */
	cachedWriteTokens?: number;
}

export type StreamEvent =
	| { type: 'text-delta'; textDelta: string }
	| {
			type: 'tool-call-delta';
			toolCallDelta: {
				index: number;
				id?: string;
				name?: string;
				argumentsDelta?: string;
			};
	  }
	| { type: 'finish'; finishReason: string }
	| { type: 'usage'; usage: TurnUsage }
	| { type: 'error'; error: string };

export interface AssembledTurn {
	text: string;
	toolCalls: ToolCall[];
	finishReason: string;
	usage?: TurnUsage;
}

export interface TurnRequest {
	endpoint: Endpoint;
	model: string;
	/** Active context chain in Pi v3 format. The provider serializes to its wire shape. */
	chain: Entry[];
	systemPrompt: string;
	tools: ToolDescriptor[];
	/** When provided, the provider prepends this to the most recent user-text message. */
	pinnedPreamble?: string;
	/** Opt-in for providers that support it (Anthropic native). Silently ignored elsewhere. */
	enablePromptCaching?: boolean;
	signal?: AbortSignal;
}

export interface ImageAttachment {
	/** Vault path or other addressable identifier. */
	path: string;
	mime: string;
	/** Resolved bytes read by the caller (storage layer). */
	bytes: ArrayBuffer;
}

/** Resolves an image block to bytes. Storage owns vault IO; the provider just
 * receives the resolver and calls it during message rendering. */
export type ImageResolver = (path: string) => Promise<ArrayBuffer | null>;

export interface ProviderCapabilities {
	/** True when the provider supports prompt caching (Anthropic `cache_control`). */
	supportsCachedPrompt: boolean;
}

export interface StreamCallbacks {
	onText?: (delta: string) => void;
	onToolCallProgress?: (index: number, partial: { id?: string; name?: string; argsAccum: string }) => void;
	onUsage?: (u: TurnUsage) => void;
}

/** Cheap result from a connection probe — what the Test row shows. */
export interface TestProbeResult {
	message: string;
}

export interface Provider {
	readonly capabilities: ProviderCapabilities;
	streamTurn(req: TurnRequest, resolveImage: ImageResolver): AsyncGenerator<StreamEvent>;
	runTurn(req: TurnRequest, resolveImage: ImageResolver, cb?: StreamCallbacks): Promise<AssembledTurn>;
	discoverModels(endpoint: Endpoint, signal?: AbortSignal): Promise<DiscoveredModel[]>;
	/**
	 * Cheap liveness probe of the URL + key. Optional — when undefined, callers
	 * fall back to discoverModels. Override when the protocol's chat surface is
	 * mandatory but the metadata endpoint (/models, etc.) is not — many
	 * Anthropic-compatible gateways serve /v1/messages without /v1/models.
	 */
	testConnection?(endpoint: Endpoint, signal?: AbortSignal): Promise<TestProbeResult>;
}

/** Re-export Tool so provider implementations have one import path. */
export type { Tool };
