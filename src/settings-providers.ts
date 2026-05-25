import { Setting } from 'obsidian';
import {
	defaultOpenRouterEndpoint,
	endpointSummary,
	isEndpointConnected,
	newEndpointId,
} from './settings';
import type { Endpoint } from './types';
import { AddEndpointModal, EndpointTemplate } from './modal-add-endpoint';
import type { SectionContext } from './settings-section';

export function renderProviders(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Providers').setHeading();
	heading.settingEl.setAttribute('data-section', 'providers');

	root.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text: 'A provider is a service that runs models — OpenRouter, OpenAI, Anthropic, Gemini, a local server, or any OpenAI-compatible endpoint. Click Edit to set the key, test the connection, or refresh the model list.',
	});

	const list = root.createDiv({ cls: 'vk-endpoint-list' });
	for (const endpoint of ctx.plugin.settings.endpoints) {
		renderProviderRow(list, endpoint, ctx);
	}

	new Setting(root).addButton((btn) =>
		btn
			.setButtonText('+ Add provider')
			.setCta()
			.onClick(() => openAddProviderFlow(ctx)),
	);
}

function renderProviderRow(parent: HTMLElement, endpoint: Endpoint, ctx: SectionContext): void {
	const row = parent.createDiv({ cls: 'vk-endpoint-row' });
	row.toggleClass('vk-endpoint-row-connected', isEndpointConnected(endpoint));

	const dot = row.createDiv({ cls: 'vk-endpoint-dot' });
	dot.title = isEndpointConnected(endpoint) ? 'Connected' : 'Needs attention';

	const info = row.createDiv({ cls: 'vk-endpoint-info' });
	info.createDiv({ cls: 'vk-endpoint-name-row', text: endpoint.name || endpoint.id });
	const summary = info.createDiv({ cls: 'vk-endpoint-summary-row', text: endpointSummary(endpoint) });
	summary.title = endpoint.baseURL;

	const actions = row.createDiv({ cls: 'vk-endpoint-row-actions' });
	const editBtn = actions.createEl('button', { text: 'Edit', cls: 'vk-endpoint-edit-btn' });
	editBtn.addEventListener('click', () => ctx.enterEndpointEditor(endpoint.id));
}

function openAddProviderFlow(ctx: SectionContext): void {
	new AddEndpointModal(ctx.app, async (template: EndpointTemplate) => {
		const id = newEndpointId(ctx.plugin.settings.endpoints);
		const isOpenRouterTemplate = template.baseURL.includes('openrouter.ai');
		const newEndpoint: Endpoint = isOpenRouterTemplate
			? defaultOpenRouterEndpoint('', undefined)
			: {
					id,
					name: template.name === 'Custom' ? 'New endpoint' : template.name,
					baseURL: template.baseURL,
					apiKey: '',
					...(template.models ? { models: [...template.models] } : {}),
					...(template.protocol ? { protocol: template.protocol } : {}),
			  };
		if (isOpenRouterTemplate) {
			// defaultOpenRouterEndpoint hardcodes id 'openrouter'; rebind so
			// multiple OpenRouter endpoints (personal + work) don't collide.
			newEndpoint.id = id;
			if (template.name && template.name !== 'OpenRouter') newEndpoint.name = template.name;
		}
		ctx.plugin.settings.endpoints.push(newEndpoint);
		await ctx.plugin.saveSettings();
		ctx.redisplay();
		ctx.enterEndpointEditor(newEndpoint.id);
	}).open();
}
