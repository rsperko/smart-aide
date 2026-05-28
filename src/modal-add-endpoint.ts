import { App, Modal } from 'obsidian';
import { DEFAULT_MODEL_LIST } from './models';
import type { Endpoint, EndpointProtocol } from './types';

export interface EndpointTemplate {
	name: string;
	baseURL: string;
	hint?: string;
	/** Curated starter model slugs in the format this endpoint expects. */
	models?: string[];
	/** Defaults to 'openai-compat' when omitted. */
	protocol?: EndpointProtocol;
}

/** Provider-specific default model lists. Used by the endpoint editor's
 * "Reset to defaults" action only — templates no longer pre-seed `models`,
 * since every built-in provider exposes /models discovery that's authoritative
 * once a key is set. Keep lists tight — latest stable per tier, no legacy. */
export const DEFAULT_MODELS_OPENAI = ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5-mini', 'o3', 'o3-mini'];
export const DEFAULT_MODELS_ANTHROPIC = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];
export const DEFAULT_MODELS_GEMINI = ['gemini-3.5-flash', 'gemini-3.1-pro-preview'];

export const ENDPOINT_TEMPLATES: EndpointTemplate[] = [
	{
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		hint: 'Multi-provider gateway',
	},
	{
		name: 'OpenAI',
		baseURL: 'https://api.openai.com/v1',
		hint: 'GPT models, direct',
	},
	{
		name: 'Anthropic (native)',
		baseURL: 'https://api.anthropic.com',
		hint: 'Claude direct — supports prompt caching',
		protocol: 'anthropic',
	},
	{
		name: 'Gemini (native)',
		baseURL: 'https://generativelanguage.googleapis.com',
		hint: 'Gemini direct — long context, implicit caching, native multimodal',
		protocol: 'gemini',
	},
	{
		name: 'Anthropic (compat)',
		baseURL: 'https://api.anthropic.com/v1',
		hint: 'Claude via OpenAI-compatible endpoint',
	},
	{
		name: 'Custom',
		baseURL: '',
		hint: 'Any OpenAI-compatible endpoint — local server, gateway, anything else',
	},
];

/**
 * Return the current curated default model list for the given endpoint, or
 * null when there's no canonical default (e.g. user-defined custom endpoint).
 * Drives the "Reset to defaults" action — when the bundled defaults change,
 * the next reset picks up the new list with no migration code.
 */
export function defaultModelsFor(endpoint: Endpoint): string[] | null {
	if (endpoint.protocol === 'anthropic') return [...DEFAULT_MODELS_ANTHROPIC];
	if (endpoint.protocol === 'gemini') return [...DEFAULT_MODELS_GEMINI];

	const url = (endpoint.baseURL || '').toLowerCase();
	if (url.includes('openrouter.ai')) return [...DEFAULT_MODEL_LIST];
	if (url.includes('api.openai.com')) return [...DEFAULT_MODELS_OPENAI];
	if (url.includes('api.anthropic.com')) return [...DEFAULT_MODELS_ANTHROPIC];
	return null;
}

export class AddEndpointModal extends Modal {
	constructor(app: App, private onPick: (template: EndpointTemplate) => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Add provider');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vk-add-endpoint-modal');

		contentEl.createDiv({
			cls: 'setting-item-description',
			text: 'Pick a provider to prefill the base URL. Models populate from /models once you add an API key.',
		});

		for (const tmpl of ENDPOINT_TEMPLATES) {
			const row = contentEl.createDiv({ cls: 'vk-template-row' });
			const main = row.createDiv({ cls: 'vk-template-main' });
			main.createDiv({ cls: 'vk-template-name', text: tmpl.name });
			if (tmpl.hint) main.createDiv({ cls: 'vk-template-hint', text: tmpl.hint });
			if (tmpl.baseURL) row.createDiv({ cls: 'vk-template-url', text: tmpl.baseURL });

			row.addEventListener('click', () => {
				this.close();
				this.onPick(tmpl);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
