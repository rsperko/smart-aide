import { describe, expect, it } from 'vitest';
import { createThinkStripper } from '../src/providers/think-strip';

describe('createThinkStripper', () => {
	it('passes through plain text with no tags', () => {
		const s = createThinkStripper();
		expect(s.push('hello world')).toEqual({ visible: 'hello world', reasoning: '' });
		expect(s.flush()).toEqual({ visible: '', reasoning: '' });
	});

	it('strips a fully-formed <think>...</think> block from a single chunk', () => {
		const s = createThinkStripper();
		expect(s.push('<think>hmm</think>answer')).toEqual({
			visible: 'answer',
			reasoning: 'hmm',
		});
	});

	it('handles an open tag boundary spanning chunks', () => {
		const s = createThinkStripper();
		const c1 = s.push('a<thi');
		const c2 = s.push('nk>b</th');
		const c3 = s.push('ink>c');
		expect(c1.visible + c2.visible + c3.visible).toBe('ac');
		expect(c1.reasoning + c2.reasoning + c3.reasoning).toBe('b');
	});

	it('treats a non-think tag-like sequence as visible text', () => {
		const s = createThinkStripper();
		const out = s.push('<thinkering>not a tag</thinkering>');
		expect(out.visible).toBe('<thinkering>not a tag</thinkering>');
		expect(out.reasoning).toBe('');
		expect(s.flush()).toEqual({ visible: '', reasoning: '' });
	});

	it('emits a lone < that does not start a tag as visible text', () => {
		const s = createThinkStripper();
		const out = s.push('1 < 2 and 3 > 2');
		expect(out.visible).toBe('1 < 2 and 3 > 2');
		expect(out.reasoning).toBe('');
	});

	it('on flush emits an unclosed <think> buffer as reasoning', () => {
		const s = createThinkStripper();
		const c1 = s.push('start<think>partial');
		expect(c1.visible).toBe('start');
		expect(c1.reasoning).toBe('partial');
		const flushed = s.flush();
		expect(flushed.visible).toBe('');
		expect(flushed.reasoning).toBe('');
	});

	it('on flush flushes a buffered partial open tag as visible text', () => {
		const s = createThinkStripper();
		const c1 = s.push('keep<thi');
		expect(c1.visible).toBe('keep');
		const flushed = s.flush();
		expect(flushed.visible).toBe('<thi');
		expect(flushed.reasoning).toBe('');
	});

	it('handles multiple think blocks in one stream', () => {
		const s = createThinkStripper();
		const out = s.push('a<think>r1</think>b<think>r2</think>c');
		expect(out.visible).toBe('abc');
		expect(out.reasoning).toBe('r1r2');
	});

	it('emits reasoning incrementally while inside an open think block', () => {
		const s = createThinkStripper();
		const c1 = s.push('<think>chunk1 ');
		const c2 = s.push('chunk2');
		expect(c1.visible).toBe('');
		expect(c1.reasoning).toBe('chunk1 ');
		expect(c2.reasoning).toBe('chunk2');
	});

	it('is case-insensitive on the tag name', () => {
		const s = createThinkStripper();
		const out = s.push('<THINK>hidden</THINK>shown');
		expect(out.visible).toBe('shown');
		expect(out.reasoning).toBe('hidden');
	});
});
