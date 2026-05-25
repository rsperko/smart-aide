import { describe, expect, it, vi } from 'vitest';
import { assembleStream } from '../src/providers/stream-runner';
import type {
	AssembledTurn,
	ImageResolver,
	StreamCallbacks,
	StreamEvent,
	TurnRequest,
} from '../src/providers/types';

function makeStream(events: StreamEvent[]): (req: TurnRequest, resolveImage: ImageResolver) => AsyncGenerator<StreamEvent> {
	return async function* () {
		for (const ev of events) yield ev;
	};
}

const dummyReq = {} as TurnRequest;
const dummyResolver: ImageResolver = async () => null;

async function run(
	events: StreamEvent[],
	cb?: StreamCallbacks,
	options?: { defaultToolArguments?: string },
): Promise<AssembledTurn> {
	return assembleStream(makeStream(events), dummyReq, dummyResolver, cb, options);
}

describe('assembleStream — text accumulation', () => {
	it('concatenates text-delta events into the final text', async () => {
		const out = await run([
			{ type: 'text-delta', textDelta: 'hello' },
			{ type: 'text-delta', textDelta: ' ' },
			{ type: 'text-delta', textDelta: 'world' },
		]);
		expect(out.text).toBe('hello world');
	});

	it('forwards every text delta to onText in order', async () => {
		const seen: string[] = [];
		await run(
			[
				{ type: 'text-delta', textDelta: 'a' },
				{ type: 'text-delta', textDelta: 'b' },
				{ type: 'text-delta', textDelta: 'c' },
			],
			{ onText: (d) => seen.push(d) },
		);
		expect(seen).toEqual(['a', 'b', 'c']);
	});

	it('ignores text-delta with an empty string (treated as falsy)', async () => {
		const seen: string[] = [];
		const out = await run(
			[
				{ type: 'text-delta', textDelta: '' },
				{ type: 'text-delta', textDelta: 'kept' },
			],
			{ onText: (d) => seen.push(d) },
		);
		expect(out.text).toBe('kept');
		expect(seen).toEqual(['kept']);
	});
});

describe('assembleStream — tool call assembly', () => {
	it('accumulates argumentsDelta per index and preserves order', async () => {
		const out = await run([
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo', argumentsDelta: '{"x":' } },
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, argumentsDelta: '1}' } },
		]);
		expect(out.toolCalls).toEqual([{ id: 'c1', name: 'foo', arguments: '{"x":1}' }]);
	});

	it('sorts tool calls by index, not by arrival order', async () => {
		const out = await run([
			{ type: 'tool-call-delta', toolCallDelta: { index: 1, id: 'b', name: 'second', argumentsDelta: '{}' } },
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'a', name: 'first', argumentsDelta: '{}' } },
		]);
		expect(out.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('lets id and name be set in any later delta (not only the first)', async () => {
		const out = await run([
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, argumentsDelta: '{}' } },
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'late-id' } },
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, name: 'late-name' } },
		]);
		expect(out.toolCalls).toEqual([{ id: 'late-id', name: 'late-name', arguments: '{}' }]);
	});

	it('reports per-delta progress to onToolCallProgress with the running accumulator', async () => {
		const progress: { index: number; id?: string; name?: string; argsAccum: string }[] = [];
		await run(
			[
				{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo', argumentsDelta: '{"a":' } },
				{ type: 'tool-call-delta', toolCallDelta: { index: 0, argumentsDelta: '1}' } },
			],
			{ onToolCallProgress: (index, partial) => progress.push({ index, ...partial }) },
		);
		expect(progress).toEqual([
			{ index: 0, id: 'c1', name: 'foo', argsAccum: '{"a":' },
			{ index: 0, id: 'c1', name: 'foo', argsAccum: '{"a":1}' },
		]);
	});

	it('keeps empty argument string when no fallback is configured (OpenAI-compat behavior)', async () => {
		const out = await run([
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo' } },
		]);
		expect(out.toolCalls).toEqual([{ id: 'c1', name: 'foo', arguments: '' }]);
	});

	it('substitutes defaultToolArguments when the args stream was empty (Anthropic/Gemini behavior)', async () => {
		const out = await run(
			[{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo' } }],
			undefined,
			{ defaultToolArguments: '{}' },
		);
		expect(out.toolCalls).toEqual([{ id: 'c1', name: 'foo', arguments: '{}' }]);
	});

	it('does NOT overwrite non-empty args with the fallback', async () => {
		const out = await run(
			[
				{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo', argumentsDelta: '{"a":1}' } },
			],
			undefined,
			{ defaultToolArguments: '{}' },
		);
		expect(out.toolCalls[0].arguments).toBe('{"a":1}');
	});
});

describe('assembleStream — usage and finish', () => {
	it('captures the latest usage event and forwards to onUsage', async () => {
		const seen: { promptTokens: number; completionTokens: number }[] = [];
		const out = await run(
			[
				{ type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } },
				{ type: 'usage', usage: { promptTokens: 12, completionTokens: 7 } },
			],
			{ onUsage: (u) => seen.push({ promptTokens: u.promptTokens, completionTokens: u.completionTokens }) },
		);
		expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 7 });
		expect(seen).toEqual([
			{ promptTokens: 10, completionTokens: 5 },
			{ promptTokens: 12, completionTokens: 7 },
		]);
	});

	it('uses the finishReason from a finish event', async () => {
		const out = await run([
			{ type: 'text-delta', textDelta: 'hi' },
			{ type: 'finish', finishReason: 'tool_use' },
		]);
		expect(out.finishReason).toBe('tool_use');
	});

	it('defaults finishReason to "stop" when no finish event arrives', async () => {
		const out = await run([{ type: 'text-delta', textDelta: 'hi' }]);
		expect(out.finishReason).toBe('stop');
	});

	it('returns undefined usage when no usage event was emitted', async () => {
		const out = await run([{ type: 'text-delta', textDelta: 'hi' }]);
		expect(out.usage).toBeUndefined();
	});
});

describe('assembleStream — error', () => {
	it('throws when an error event fires', async () => {
		await expect(
			run([
				{ type: 'text-delta', textDelta: 'hi' },
				{ type: 'error', error: 'boom' },
			]),
		).rejects.toThrow('boom');
	});

	it('falls back to a generic message when the error string is empty', async () => {
		await expect(
			run([
				// `error: ''` is intentional — provider gives us nothing useful.
				{ type: 'error', error: '' } as StreamEvent,
			]),
		).rejects.toThrow('stream error');
	});
});

describe('assembleStream — callback safety', () => {
	it('works without any callbacks supplied', async () => {
		const out = await run([
			{ type: 'text-delta', textDelta: 'hi' },
			{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo', argumentsDelta: '{}' } },
			{ type: 'usage', usage: { promptTokens: 1, completionTokens: 1 } },
			{ type: 'finish', finishReason: 'stop' },
		]);
		expect(out.text).toBe('hi');
		expect(out.toolCalls).toHaveLength(1);
	});

	it('does not invoke onText when there are no text deltas', async () => {
		const onText = vi.fn();
		await run(
			[{ type: 'tool-call-delta', toolCallDelta: { index: 0, id: 'c1', name: 'foo', argumentsDelta: '{}' } }],
			{ onText },
		);
		expect(onText).not.toHaveBeenCalled();
	});
});
