import { providerFor } from './providers';
import { resolveModelRef } from './settings';
import type SmartAidePlugin from './main';
import type { Entry, ModelRef } from './types';

/**
 * Inline edit (Track A): given a text selection from the active editor, the
 * full document around it, and a natural-language instruction, ask the model
 * to rewrite just the selection — *with* full-document context so it can
 * resolve references and match the surrounding voice. Returns the proposed
 * replacement text; the caller decides whether to apply via
 * `editor.replaceSelection`.
 *
 * One-shot model call — no tools, no multi-turn loop, no streaming UI
 * buffering. AGENTS.md + memory.md flow through the system prompt so vault
 * conventions and remembered user preferences are honored.
 */

// Markers used to bracket the selected text inside the document body. Unique
// enough that they won't conflict with user content. Documented to the model
// so it knows what to return.
const SEL_OPEN = '<<<SMART_AIDE_SELECTION>>>';
const SEL_CLOSE = '<<<END_SMART_AIDE_SELECTION>>>';

// Soft cap on the full document body sent as context. Matches read_note's
// auto-truncate threshold (60KB). Above this we trim symmetrically around
// the selection so the markers stay visible.
const MAX_DOC_BYTES = 60_000;
const TRUNCATED_WINDOW_BYTES = 12_500;

const SYSTEM_PROMPT = [
	"You are editing a text selection inside the user's Markdown document.",
	'',
	'You will see:',
	'1. Optional "Vault context" — preferences the user maintains for the agent.',
	'2. Optional "Persistent memory" — facts about the user picked up across chats.',
	`3. The full document with the selection bracketed by ${SEL_OPEN} and ${SEL_CLOSE}.`,
	'4. The user\'s instruction.',
	'',
	`Return ONLY the new text that should REPLACE what is between the ${SEL_OPEN} and ${SEL_CLOSE} markers.`,
	'Do not return the markers, the surrounding document, any preamble, any explanation, or any wrapping code fence.',
	'',
	'Use the surrounding document for context (terminology, voice, list style, heading level). Match its conventions. Do not modify any content outside the markers.',
].join('\n');

export interface EditPrompt {
	system: string;
	user: string;
}

export interface EditRequestInput {
	selection: string;
	instruction: string;
	/** Full editor document text. May be truncated before going on the wire. */
	documentText: string;
	/** 0-indexed line + 0-indexed column of selection start in `documentText`. */
	from: { line: number; ch: number };
	/** 0-indexed line + 0-indexed column of selection end in `documentText`. */
	to: { line: number; ch: number };
	/** AGENTS.md body, joined root + metaDir as the registry already does. */
	agentsBody?: string;
	/** memory.md body. */
	memoryBody?: string;
}

export function buildEditPrompt(input: EditRequestInput): EditPrompt {
	const marked = injectSelectionMarkers(input.documentText, input.from, input.to);
	const bodyForWire = capDocumentForWire(marked);

	const sections: string[] = [];
	if (input.agentsBody && input.agentsBody.trim()) {
		sections.push(`Vault context (user-maintained):\n\n${input.agentsBody.trim()}`);
	}
	if (input.memoryBody && input.memoryBody.trim()) {
		sections.push(`Persistent memory:\n\n${input.memoryBody.trim()}`);
	}
	sections.push(`Document (selection between markers):\n\n${bodyForWire}`);
	sections.push(`Instruction: ${input.instruction}`);

	return { system: SYSTEM_PROMPT, user: sections.join('\n\n') };
}

/**
 * Insert the open/close markers around the selection's character range. The
 * close-then-open insertion order keeps the open offset valid after the
 * close insertion shifts the tail.
 */
export function injectSelectionMarkers(
	doc: string,
	from: { line: number; ch: number },
	to: { line: number; ch: number },
): string {
	const fromOffset = offsetFor(doc, from.line, from.ch);
	const toOffset = offsetFor(doc, to.line, to.ch);
	if (fromOffset < 0 || toOffset < 0 || fromOffset > toOffset) {
		// Couldn't resolve positions; fall back to wrapping the selection at the
		// start of the doc. Better than silently dropping the markers.
		return `${SEL_OPEN}${doc.slice(0, 0)}${SEL_CLOSE}\n\n${doc}`;
	}
	return (
		doc.slice(0, fromOffset) +
		SEL_OPEN +
		doc.slice(fromOffset, toOffset) +
		SEL_CLOSE +
		doc.slice(toOffset)
	);
}

function offsetFor(doc: string, line: number, ch: number): number {
	const lines = doc.split('\n');
	if (line < 0 || line >= lines.length) return -1;
	let offset = 0;
	for (let i = 0; i < line; i++) offset += lines[i].length + 1;
	return offset + Math.max(0, Math.min(ch, lines[line].length));
}

/**
 * Cap the document we put on the wire. Under MAX_DOC_BYTES, send everything.
 * Above it, keep a window around the selection markers so the model still
 * gets local context but we don't blow the token budget.
 */
export function capDocumentForWire(marked: string): string {
	if (marked.length <= MAX_DOC_BYTES) return marked;
	const idx = marked.indexOf(SEL_OPEN);
	if (idx < 0) return marked.slice(0, MAX_DOC_BYTES) + '\n\n…(truncated)';

	const closeIdx = marked.indexOf(SEL_CLOSE);
	const selectionEnd = closeIdx >= 0 ? closeIdx + SEL_CLOSE.length : idx + SEL_OPEN.length;

	const start = Math.max(0, idx - TRUNCATED_WINDOW_BYTES);
	const end = Math.min(marked.length, selectionEnd + TRUNCATED_WINDOW_BYTES);

	const before = start > 0 ? '…(document truncated above)\n\n' : '';
	const after = end < marked.length ? '\n\n…(document truncated below)' : '';
	return before + marked.slice(start, end) + after;
}

/**
 * Strip a single wrapping code fence if the model ignored the "no fence"
 * instruction. Preserves inner code blocks. Trims surrounding whitespace.
 */
export function extractRewrite(modelText: string): string {
	let text = modelText.replace(/^\s+|\s+$/g, '');
	if (!text.startsWith('```')) return text;
	const firstNewline = text.indexOf('\n');
	if (firstNewline < 0) return text;
	const openingFence = text.slice(0, firstNewline);
	if (!/^```[a-zA-Z0-9+-]*\s*$/.test(openingFence)) return text;
	const rest = text.slice(firstNewline + 1);
	const closeIdx = rest.lastIndexOf('```');
	if (closeIdx < 0) return text;
	const trailing = rest.slice(closeIdx + 3).replace(/^\s+|\s+$/g, '');
	if (trailing.length > 0) return text;
	return rest.slice(0, closeIdx).replace(/^\s+|\s+$/g, '');
}

export async function runEditRequest(
	plugin: SmartAidePlugin,
	modelRef: ModelRef,
	input: EditRequestInput,
	signal: AbortSignal,
): Promise<string> {
	const { system, user } = buildEditPrompt(input);
	const { endpoint, slug } = resolveModelRef(plugin.settings, modelRef);
	const provider = providerFor(endpoint);
	const chain: Entry[] = [
		{
			id: 'edit-1',
			parentId: null,
			timestamp: new Date().toISOString(),
			type: 'message',
			message: { role: 'user', content: user },
		},
	];
	const assembled = await provider.runTurn(
		{
			endpoint,
			model: slug,
			chain,
			systemPrompt: system,
			tools: [],
			enablePromptCaching: false,
			signal,
		},
		async () => null,
	);
	const text = extractRewrite(assembled.text);
	if (!text) throw new Error('Model returned empty rewrite');
	return text;
}
