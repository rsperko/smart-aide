/**
 * Streaming-safe `<think>...</think>` splitter for OpenAI-compat text deltas.
 *
 * Many open / local reasoning models (Qwen-thinking, Ollama gpt-oss, DeepSeek-V3
 * with thinking enabled, etc.) emit reasoning inline as `<think>…</think>` in
 * the regular content stream. Without filtering, that block (a) renders verbatim
 * in the assistant bubble, and (b) gets persisted as part of the assistant text,
 * which is then re-sent on the next turn and can trigger provider 400s.
 *
 * push(chunk) splits the chunk into a visible portion (outside any think block)
 * and a reasoning portion (inside). Tag boundaries that span chunk boundaries
 * are buffered until they can be resolved. flush() drains the buffer at end-of-
 * stream — a residual partial open tag is emitted as visible; a residual
 * unclosed reasoning block is emitted as reasoning.
 */

export interface ThinkSplitChunk {
	visible: string;
	reasoning: string;
}

export interface ThinkStripper {
	push(chunk: string): ThinkSplitChunk;
	flush(): ThinkSplitChunk;
}

const OPEN = '<think>';
const CLOSE = '</think>';

function startsWithCI(s: string, prefix: string): boolean {
	if (s.length < prefix.length) return false;
	return s.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function isProperPrefixCI(maybePrefix: string, full: string): boolean {
	if (maybePrefix.length === 0 || maybePrefix.length >= full.length) return false;
	return full.slice(0, maybePrefix.length).toLowerCase() === maybePrefix.toLowerCase();
}

export function createThinkStripper(): ThinkStripper {
	let buffer = '';
	let inside = false;

	function step(): ThinkSplitChunk {
		let visible = '';
		let reasoning = '';

		while (buffer.length > 0) {
			const ltIdx = buffer.indexOf('<');
			if (ltIdx === -1) {
				if (inside) reasoning += buffer;
				else visible += buffer;
				buffer = '';
				break;
			}

			const leading = buffer.slice(0, ltIdx);
			if (inside) reasoning += leading;
			else visible += leading;
			buffer = buffer.slice(ltIdx);

			const target = inside ? CLOSE : OPEN;
			if (startsWithCI(buffer, target)) {
				buffer = buffer.slice(target.length);
				inside = !inside;
				continue;
			}
			if (isProperPrefixCI(buffer, target)) {
				break;
			}
			if (inside) reasoning += '<';
			else visible += '<';
			buffer = buffer.slice(1);
		}

		return { visible, reasoning };
	}

	return {
		push(chunk: string): ThinkSplitChunk {
			buffer += chunk;
			return step();
		},
		flush(): ThinkSplitChunk {
			if (buffer.length === 0) return { visible: '', reasoning: '' };
			const out: ThinkSplitChunk = inside
				? { visible: '', reasoning: buffer }
				: { visible: buffer, reasoning: '' };
			buffer = '';
			return out;
		},
	};
}
