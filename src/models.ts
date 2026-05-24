/**
 * Friendly display names + provider extraction for OpenRouter model slugs.
 * Extend FRIENDLY_NAMES as new models become commonly used.
 *
 * Notes on naming conventions:
 * - Newer Anthropic 4.x slugs use dots (claude-haiku-4.5); older 3.x and earlier
 *   used hyphens (claude-3-5-sonnet). Both are kept so saved settings keep their
 *   friendly display.
 * - OpenRouter slugs are case-sensitive.
 */

const FRIENDLY_NAMES: Record<string, string> = {
	// Anthropic — current (dot format)
	'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
	'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
	'anthropic/claude-opus-4.7': 'Claude Opus 4.7',
	'anthropic/claude-opus-4.7-fast': 'Claude Opus 4.7 (Fast)',
	// Anthropic — legacy hyphen format (preserved for existing settings)
	'anthropic/claude-haiku-4-5': 'Claude Haiku 4.5',
	'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6',
	'anthropic/claude-opus-4-7': 'Claude Opus 4.7',
	'anthropic/claude-3-5-haiku': 'Claude 3.5 Haiku',
	'anthropic/claude-3-5-sonnet': 'Claude 3.5 Sonnet',
	'anthropic/claude-3-7-sonnet': 'Claude 3.7 Sonnet',
	// OpenAI
	'openai/gpt-5.5': 'GPT-5.5',
	'openai/gpt-5.5-pro': 'GPT-5.5 Pro',
	'openai/gpt-5.2': 'GPT-5.2',
	'openai/gpt-5': 'GPT-5',
	'openai/gpt-5-mini': 'GPT-5 mini',
	'openai/gpt-4o': 'GPT-4o',
	'openai/gpt-4o-mini': 'GPT-4o mini',
	'openai/o1': 'o1',
	'openai/o3': 'o3',
	'openai/o3-mini': 'o3 mini',
	// Google
	'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
	'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
	'google/gemini-3-pro-preview': 'Gemini 3 Pro',
	'google/gemini-3-flash-preview': 'Gemini 3 Flash',
	'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
	'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
	'google/gemini-2.0-flash': 'Gemini 2.0 Flash',
	'google/gemini-2.0-pro': 'Gemini 2.0 Pro',
	'google/gemini-flash-1.5': 'Gemini Flash 1.5',
	'google/gemini-flash-1.5-8b': 'Gemini Flash 1.5 8B',
	'google/gemini-pro-1.5': 'Gemini Pro 1.5',
	// Qwen
	'qwen/qwen3.6-plus': 'Qwen 3.6 Plus',
	'qwen/qwen3.6-flash': 'Qwen 3.6 Flash',
	'qwen/qwen3.6-27b': 'Qwen 3.6 27B',
	'qwen/qwen3.6-max-preview': 'Qwen 3.6 Max',
	'qwen/qwen-2.5-72b-instruct': 'Qwen 2.5 72B',
	// DeepSeek
	'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
	'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
	'deepseek/deepseek-chat': 'DeepSeek Chat',
	// Meta
	'meta-llama/llama-4-maverick': 'Llama 4 Maverick',
	'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
	// Mistral
	'mistralai/mistral-large-3': 'Mistral Large 3',
	'mistralai/mistral-large': 'Mistral Large',
};

export function friendlyModelName(slug: string): string {
	if (FRIENDLY_NAMES[slug]) return FRIENDLY_NAMES[slug];
	// Slugs from direct provider endpoints (OpenAI, Anthropic compat) have no `provider/` prefix —
	// try common prefixes so they pick up the same friendly names as their OpenRouter form.
	if (!slug.includes('/')) {
		for (const prefix of ['anthropic/', 'openai/', 'google/']) {
			if (FRIENDLY_NAMES[prefix + slug]) return FRIENDLY_NAMES[prefix + slug];
		}
	}
	const tail = slug.includes('/') ? slug.slice(slug.lastIndexOf('/') + 1) : slug;
	return tail
		.split(/[-_]/)
		.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
		.join(' ')
		.trim();
}

/**
 * Update a recents list: move the picked ModelRef to the front, dedupe, cap.
 */
import type { ModelRef } from './types';

export function bumpRecent(recents: ModelRef[], picked: ModelRef, max = 5): ModelRef[] {
	const filtered = recents.filter((r) => !(r.endpointId === picked.endpointId && r.slug === picked.slug));
	return [picked, ...filtered].slice(0, max);
}

/**
 * The default curated set shipped for OpenRouter endpoints. Mirrored in
 * defaultModelsFor() so "Reset to defaults" in the endpoint editor restores
 * exactly this list. Tight by design — one or two per major lab; users add
 * more via the manual model list field.
 */
export const DEFAULT_MODEL_LIST: string[] = [
	'anthropic/claude-haiku-4.5',
	'anthropic/claude-sonnet-4.6',
	'anthropic/claude-opus-4.7',
	'openai/gpt-5.5',
	'openai/gpt-5.5-pro',
	'google/gemini-3.5-flash',
	'google/gemini-3.1-pro-preview',
	'deepseek/deepseek-v4-flash',
];

export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
