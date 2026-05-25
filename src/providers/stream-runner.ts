import type {
	AssembledTurn,
	ImageResolver,
	StreamCallbacks,
	StreamEvent,
	ToolCall,
	TurnRequest,
} from './types';

export interface AssembleOptions {
	/**
	 * Value to substitute for a tool call whose argument stream ended up empty.
	 * OpenAI-compat preserves the original empty string; Anthropic and Gemini
	 * coerce to '{}' so the wire payload parses as a valid JSON object on the
	 * next turn. Provider-specific.
	 */
	defaultToolArguments?: string;
}

type StreamFn = (req: TurnRequest, resolveImage: ImageResolver) => AsyncGenerator<StreamEvent>;

/**
 * Consume a provider stream and assemble the final turn. Three providers had
 * near-identical copies of this loop — the only meaningful difference was
 * `defaultToolArguments`. Centralizing the accumulator means a fix to text /
 * tool-call / usage handling lands once for every protocol.
 */
export async function assembleStream(
	stream: StreamFn,
	req: TurnRequest,
	resolveImage: ImageResolver,
	cb?: StreamCallbacks,
	options: AssembleOptions = {},
): Promise<AssembledTurn> {
	let text = '';
	const toolAccum: Map<number, { id: string; name: string; args: string }> = new Map();
	let finishReason = 'stop';
	let usage: AssembledTurn['usage'] | undefined;

	for await (const ev of stream(req, resolveImage)) {
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

	const fallback = options.defaultToolArguments;
	const toolCalls: ToolCall[] = [...toolAccum.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, v]) => ({
			id: v.id,
			name: v.name,
			arguments: v.args || (fallback ?? v.args),
		}));

	return { text, toolCalls, finishReason, usage };
}
