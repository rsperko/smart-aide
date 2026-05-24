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

/** Provider-specific default model lists. Single source of truth for both
 * the AddEndpointModal seeding and the "Reset to defaults" action in the
 * endpoint editor. Keep lists tight — latest stable per tier, no legacy. */
export const DEFAULT_MODELS_OPENAI = ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5-mini', 'o3', 'o3-mini'];
export const DEFAULT_MODELS_ANTHROPIC = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];
export const DEFAULT_MODELS_GEMINI = ['gemini-3.5-flash', 'gemini-3.1-pro-preview'];

export const ENDPOINT_TEMPLATES: EndpointTemplate[] = [
	{
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		hint: 'Multi-provider gateway',
		// OpenRouter uses DEFAULT_MODEL_LIST when models is undefined —
		// see defaultOpenRouterEndpoint() in settings.ts.
	},
	{
		name: 'OpenAI',
		baseURL: 'https://api.openai.com/v1',
		hint: 'GPT models, direct',
		models: [...DEFAULT_MODELS_OPENAI],
	},
	{
		name: 'Anthropic (native)',
		baseURL: 'https://api.anthropic.com',
		hint: 'Claude direct — supports prompt caching',
		models: [...DEFAULT_MODELS_ANTHROPIC],
		protocol: 'anthropic',
	},
	{
		name: 'Gemini (native)',
		baseURL: 'https://generativelanguage.googleapis.com/v1beta',
		hint: 'Gemini direct — long context, implicit caching, native multimodal',
		models: [...DEFAULT_MODELS_GEMINI],
		protocol: 'gemini',
	},
	{
		name: 'Anthropic (compat)',
		baseURL: 'https://api.anthropic.com/v1',
		hint: 'Claude via OpenAI-compatible endpoint',
		models: [...DEFAULT_MODELS_ANTHROPIC],
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
		this.titleEl.setText('Add endpoint');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vk-add-endpoint-modal');

		contentEl.createDiv({
			cls: 'setting-item-description',
			text: 'Pick a provider to prefill the base URL and a starter set of models. You can rename and adjust afterwards.',
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
