import { providerFor } from './providers';
import { resolveModelRef } from './settings';
import type SmartAidePlugin from './main';
import type { Entry } from './types';

/**
 * Inline edit (Track A): given a text selection from the active editor and a
 * natural-language instruction, ask the chat model to rewrite the selection
 * and return the proposed text. Caller decides whether to apply via
 * `editor.replaceSelection`.
 *
 * This is a one-shot model call — no tools, no multi-turn loop, no streaming
 * UI buffering. Errors are propagated to the modal so the user sees what
 * went wrong instead of a silent empty diff.
 */

const SYSTEM_PROMPT = [
	"You are editing a text selection inside the user's Markdown document.",
	'',
	"Apply the user's instruction to the selection and return ONLY the rewritten text:",
	'- No preamble (do not say "Here is the edit" or anything before/after the rewrite).',
	'- No surrounding code fence (do not wrap the output in ``` markers).',
	'- No explanation.',
	'',
	'Preserve formatting the selection already uses (heading levels, list style, link syntax).',
	"Do not add or remove leading/trailing blank lines unless the user's instruction asks for it.",
	'If the instruction is unclear, make the smallest plausible change rather than asking back.',
].join('\n');

export interface EditPrompt {
	system: string;
	user: string;
}

export function buildEditPrompt(selection: string, instruction: string): EditPrompt {
	const user = [
		'Selection:',
		'<<<SELECTION',
		selection,
		'SELECTION',
		'',
		`Instruction: ${instruction}`,
	].join('\n');
	return { system: SYSTEM_PROMPT, user };
}

/**
 * Strip a single wrapping code fence if the model ignored the instructions
 * and returned the rewrite inside ```. Preserves inner code blocks (only
 * strips the outermost pair). Trims surrounding whitespace.
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

/**
 * Make the actual provider call. Constructs a synthetic single-message chain
 * (`Entry[]`) so the existing provider plumbing works unchanged. No tools,
 * no pinned preamble, no caching (edits are one-shot, not worth caching).
 */
export async function runEditRequest(
	plugin: SmartAidePlugin,
	selection: string,
	instruction: string,
	signal: AbortSignal,
): Promise<string> {
	const { system, user } = buildEditPrompt(selection, instruction);
	const { endpoint, slug } = resolveModelRef(plugin.settings, plugin.settings.defaultModelRef);
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
