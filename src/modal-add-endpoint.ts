import { App, Modal } from 'obsidian';
import type { EndpointProtocol } from './types';

export interface EndpointTemplate {
	name: string;
	baseURL: string;
	hint?: string;
	/** Curated starter model slugs in the format this endpoint expects. */
	models?: string[];
	/** Defaults to 'openai-compat' when omitted. */
	protocol?: EndpointProtocol;
}

export const ENDPOINT_TEMPLATES: EndpointTemplate[] = [
	{
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		hint: 'Multi-provider gateway',
		// OpenRouter uses the project's DEFAULT_MODEL_LIST when models is undefined —
		// see defaultOpenRouterEndpoint() in settings.ts.
	},
	{
		name: 'OpenAI',
		baseURL: 'https://api.openai.com/v1',
		hint: 'GPT models, direct',
		models: ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5-mini', 'o3', 'o3-mini'],
	},
	{
		name: 'Anthropic (native)',
		baseURL: 'https://api.anthropic.com',
		hint: 'Claude direct — supports prompt caching',
		models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
		protocol: 'anthropic',
	},
	{
		name: 'Gemini (native)',
		baseURL: 'https://generativelanguage.googleapis.com/v1beta',
		hint: 'Gemini direct — long context, implicit caching, native multimodal',
		models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
		protocol: 'gemini',
	},
	{
		name: 'Anthropic (compat)',
		baseURL: 'https://api.anthropic.com/v1',
		hint: 'Claude via OpenAI-compatible endpoint',
		models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
	},
	{
		name: 'Custom',
		baseURL: '',
		hint: 'Any OpenAI-compatible endpoint — local server, gateway, anything else',
	},
];

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
