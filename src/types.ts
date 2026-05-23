// Pi session format (v3) — subset used by smart-aide.
// See agent_notes/initial_design/03-architecture.md for the full design.

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ToolCallBlock {
	type: 'toolCall';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
	type: 'toolResult';
	toolCallId: string;
	content: string;
	isError?: boolean;
}

/**
 * Image attachment in a user message. Stores the vault path (small in JSONL)
 * rather than the bytes; the bytes are read on send and inlined as a base64
 * data URL in the OpenAI-compat `image_url` block.
 */
export interface ImageBlock {
	type: 'image';
	path: string;
	mime: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ImageBlock;

export interface AgentMessage {
	role: Role;
	content: string | ContentBlock[];
}

export interface SessionHeader {
	type: 'session';
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: { id: string; path: string };
}

export interface BaseEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends BaseEntry {
	type: 'message';
	message: AgentMessage;
}

export interface ModelChangeEntry extends BaseEntry {
	type: 'model_change';
	provider: string;
	modelId: string;
}

export interface SessionInfoEntry extends BaseEntry {
	type: 'session_info';
	name: string;
}

export interface CustomEntry extends BaseEntry {
	type: 'custom';
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntry extends BaseEntry {
	type: 'custom_message';
	customType: string;
	content: string;
	display?: string;
}

export type Entry = MessageEntry | ModelChangeEntry | SessionInfoEntry | CustomEntry | CustomMessageEntry;

// Multi-endpoint config. Every endpoint speaks OpenAI-compatible chat-completions over SSE.
export interface Endpoint {
	id: string;
	name: string;
	baseURL: string;
	apiKey: string;
	headers?: Record<string, string>;
	models?: string[];
	discoveredModels?: DiscoveredModel[];
	discoveredAt?: string;
	lastTest?: { ok: boolean; at: string; message?: string };
}

export interface DiscoveredModel {
	id: string;
	name?: string;
	contextLength?: number;
	promptPrice?: number;
	completionPrice?: number;
	supportsTools?: boolean;
}

export interface ModelRef {
	endpointId: string;
	slug: string;
}

// OpenRouter / OpenAI-compatible API shapes
export interface OpenAIToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type OpenAIContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface OpenAIMessage {
	role: Role;
	content?: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

// Tool registry shape
export type ToolRisk = 'read' | 'write' | 'delete' | 'network';

export interface ToolContext {
	app: import('obsidian').App;
	metaDir: string;
}

export interface ApprovalPreview {
	summary: string;
	diff?: { kind: 'overwrite' | 'append' | 'delete'; oldContent?: string; newContent?: string; path: string };
}

export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	risk: ToolRisk;
	/** When write/delete: build a preview shown in the approval card before execution. */
	preview?(args: Record<string, unknown>, ctx: ToolContext): Promise<ApprovalPreview>;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
