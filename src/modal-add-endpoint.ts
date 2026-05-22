import { App, Modal } from 'obsidian';

export interface EndpointTemplate {
	name: string;
	baseURL: string;
	hint?: string;
}

export const ENDPOINT_TEMPLATES: EndpointTemplate[] = [
	{ name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', hint: 'Multi-provider gateway' },
	{ name: 'OpenAI', baseURL: 'https://api.openai.com/v1', hint: 'GPT models, direct' },
	{ name: 'Anthropic (compat)', baseURL: 'https://api.anthropic.com/v1', hint: 'Claude via OpenAI-compatible endpoint' },
	{ name: 'Custom', baseURL: '', hint: 'Any OpenAI-compatible endpoint — local server, gateway, anything else' },
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
			text: 'Pick a provider to prefill the base URL. You can rename and adjust afterwards.',
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
