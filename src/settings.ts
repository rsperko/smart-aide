import { App, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_MODEL, DEFAULT_MODEL_LIST, friendlyModelName } from './models';
import { DiscoveredModel, Endpoint, ModelRef } from './types';
import { ModelPickerModal } from './picker-models';
import { EndpointEditModal } from './modal-endpoint';
import { AddEndpointModal, EndpointTemplate } from './modal-add-endpoint';
import type SmartAidePlugin from './main';

export interface SmartAideSettings {
	endpoints: Endpoint[];
	defaultModelRef: ModelRef;
	titleModelRef: ModelRef;
	modelRecents: ModelRef[];
	systemPrompt: string;
}

const OPENROUTER_ID = 'openrouter';

const DEFAULT_SYSTEM_PROMPT = [
	"You help the user explore their Obsidian vault. They read on a phone half the time — keep responses tight.",
	'',
	"Between tool calls, be silent. The chat already shows what you're doing; speak only at the end of the turn.",
	'',
	'Response shape by user intent:',
	'',
	'| Intent                                | Response                                                                                          |',
	'|---------------------------------------|---------------------------------------------------------------------------------------------------|',
	'| Find / locate / "where is X"          | ≤2 sentences naming what the note is. A citation card auto-renders — don\'t quote the body.       |',
	'| What\'s in / summarize / show me X     | Tight blockquote (> ...) of just the relevant section, then one line of frame.                    |',
	'| Compare / connect notes               | Prose synthesis with `[[Path/To/Note#Heading]]` wikilinks.                                        |',
	'| Write / edit / append / delete        | Tool call. write_note carries FULL final content. One coherent change per call. Only when asked — never speculative. |',
	'',
	"Never repeat the user's question. Never paraphrase content the citation card or blockquote already shows.",
	'',
	'In wikilinks, always include the heading anchor when applicable: `[[Path/To/Note#Heading]]`. Use the heading text exactly as it appeared in the search hit or read result.',
].join('\n');

export function defaultOpenRouterEndpoint(apiKey = '', models?: string[]): Endpoint {
	return {
		id: OPENROUTER_ID,
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		apiKey,
		models: models && models.length > 0 ? models : [...DEFAULT_MODEL_LIST],
	};
}

export const DEFAULT_SETTINGS: SmartAideSettings = {
	endpoints: [defaultOpenRouterEndpoint()],
	defaultModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
	titleModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
	modelRecents: [],
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

/**
 * Migrate legacy settings (single OpenRouter key + flat model list) into the
 * multi-endpoint schema. Idempotent.
 */
export function migrateSettings(raw: Record<string, unknown> | null | undefined): SmartAideSettings {
	const r = (raw ?? {}) as Record<string, unknown>;

	if (Array.isArray(r.endpoints) && r.endpoints.length > 0) {
		return {
			endpoints: r.endpoints as Endpoint[],
			defaultModelRef: (r.defaultModelRef as ModelRef) ?? DEFAULT_SETTINGS.defaultModelRef,
			titleModelRef: (r.titleModelRef as ModelRef) ?? (r.defaultModelRef as ModelRef) ?? DEFAULT_SETTINGS.titleModelRef,
			modelRecents: Array.isArray(r.modelRecents) ? (r.modelRecents as ModelRef[]) : [],
			systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : DEFAULT_SYSTEM_PROMPT,
		};
	}

	const legacyKey = typeof r.apiKey === 'string' ? r.apiKey : '';
	const legacyModels = Array.isArray(r.models) ? (r.models as string[]) : undefined;
	const legacyDefault = typeof r.defaultModel === 'string' ? r.defaultModel : DEFAULT_MODEL;
	const legacyTitle = typeof r.titleModel === 'string' ? r.titleModel : legacyDefault;
	const legacyRecents = Array.isArray(r.modelRecents) ? (r.modelRecents as unknown[]) : [];

	const endpoint = defaultOpenRouterEndpoint(legacyKey, legacyModels);
	const recents: ModelRef[] = legacyRecents
		.map((v): ModelRef | null => {
			if (typeof v === 'string') return { endpointId: OPENROUTER_ID, slug: v };
			if (v && typeof v === 'object' && 'slug' in v) return v as ModelRef;
			return null;
		})
		.filter((v): v is ModelRef => v !== null);

	return {
		endpoints: [endpoint],
		defaultModelRef: { endpointId: OPENROUTER_ID, slug: legacyDefault },
		titleModelRef: { endpointId: OPENROUTER_ID, slug: legacyTitle },
		modelRecents: recents,
		systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : DEFAULT_SYSTEM_PROMPT,
	};
}

export function findEndpoint(settings: SmartAideSettings, id: string): Endpoint | undefined {
	return settings.endpoints.find((e) => e.id === id);
}

export function resolveModelRef(
	settings: SmartAideSettings,
	ref: ModelRef,
): { endpoint: Endpoint; slug: string } {
	const endpoint = findEndpoint(settings, ref.endpointId) ?? settings.endpoints[0];
	return { endpoint, slug: ref.slug };
}

function endpointModelCount(endpoint: Endpoint): number {
	const discovered = endpoint.discoveredModels ?? [];
	const manual = endpoint.models ?? [];
	const merged = new Set([...manual, ...discovered.map((m) => m.id)]);
	return merged.size;
}

function isEndpointConnected(endpoint: Endpoint): boolean {
	return Boolean(endpoint.apiKey) && endpointModelCount(endpoint) > 0;
}

function endpointSummary(endpoint: Endpoint): string {
	if (!endpoint.apiKey) return 'no key';
	const count = endpointModelCount(endpoint);
	const parts: string[] = [`${count} ${count === 1 ? 'model' : 'models'}`];

	if (endpoint.lastTest) {
		if (endpoint.lastTest.ok) {
			parts.push(`✓ tested ${describeFreshness(endpoint.lastTest.at)}`);
		} else {
			const msg = endpoint.lastTest.message ?? 'test failed';
			parts.push(`✗ ${msg} · ${describeFreshness(endpoint.lastTest.at)}`);
		}
	} else if (endpoint.discoveredAt) {
		parts.push(`refreshed ${describeFreshness(endpoint.discoveredAt)}`);
	} else {
		parts.push('not refreshed');
	}

	return parts.join(' · ');
}

function describeFreshness(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return iso.slice(0, 10);
	const minutes = Math.floor((Date.now() - then) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 30) return `${days}d ago`;
	return iso.slice(0, 10);
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
	return a.endpointId === b.endpointId && a.slug === b.slug;
}

function newEndpointId(existing: Endpoint[]): string {
	let i = 1;
	while (existing.some((e) => e.id === `endpoint-${i}`)) i++;
	return `endpoint-${i}`;
}

function pickReplacementModelRef(settings: SmartAideSettings, removedId: string): ModelRef {
	const fallback = settings.endpoints[0];
	const slug = fallback?.models?.[0] ?? fallback?.discoveredModels?.[0]?.id ?? DEFAULT_MODEL;
	void removedId;
	return { endpointId: fallback?.id ?? OPENROUTER_ID, slug };
}

export class SmartAideSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: SmartAidePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderEndpointsSection(containerEl);
		this.renderModelDefaults(containerEl);
		this.renderSystemPromptSection(containerEl);
	}

	private renderEndpointsSection(root: HTMLElement): void {
		new Setting(root).setName('Endpoints').setHeading();

		const hasAnyKey = this.plugin.settings.endpoints.some((e) => Boolean(e.apiKey));
		if (!hasAnyKey) this.renderGetStartedCard(root);

		root.createDiv({
			cls: 'setting-item-description vk-section-blurb',
			text: 'Each endpoint is an OpenAI-compatible URL plus an API key. Click Edit to set the key, test the connection, or refresh the model list.',
		});

		const list = root.createDiv({ cls: 'vk-endpoint-list' });
		for (const endpoint of this.plugin.settings.endpoints) {
			this.renderEndpointRow(list, endpoint);
		}

		new Setting(root).addButton((btn) =>
			btn
				.setButtonText('+ Add endpoint')
				.setCta()
				.onClick(() => this.openAddEndpointFlow()),
		);
	}

	private renderGetStartedCard(root: HTMLElement): void {
		const card = root.createDiv({ cls: 'vk-getstarted-card' });

		card.createDiv({ cls: 'vk-getstarted-title', text: 'Add an API key to start chatting' });
		card.createDiv({
			cls: 'vk-getstarted-sub',
			text: 'OpenRouter is free to sign up and pay-as-you-go — one key, every major model. Or add OpenAI, Anthropic, a local server, or any OpenAI-compatible endpoint.',
		});

		const actions = card.createDiv({ cls: 'vk-getstarted-actions' });

		const getKey = actions.createEl('button', { text: 'Get an OpenRouter key →', cls: 'mod-cta' });
		getKey.addEventListener('click', () => window.open('https://openrouter.ai/keys', '_blank'));

		const haveKey = actions.createEl('button', { text: 'I already have one' });
		haveKey.addEventListener('click', () => {
			const first = this.plugin.settings.endpoints[0];
			if (first) this.openEndpointEditor(first);
		});
	}

	private renderEndpointRow(parent: HTMLElement, endpoint: Endpoint): void {
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
		editBtn.addEventListener('click', () => this.openEndpointEditor(endpoint));
	}

	private openEndpointEditor(endpoint: Endpoint): void {
		new EndpointEditModal(
			this.app,
			endpoint,
			() => void this.plugin.saveSettings(),
			async () => {
				if (this.plugin.settings.endpoints.length <= 1) return;
				const removedId = endpoint.id;
				this.plugin.settings.endpoints = this.plugin.settings.endpoints.filter((e) => e !== endpoint);
				if (this.plugin.settings.defaultModelRef.endpointId === removedId) {
					this.plugin.settings.defaultModelRef = pickReplacementModelRef(this.plugin.settings, removedId);
				}
				if (this.plugin.settings.titleModelRef.endpointId === removedId) {
					this.plugin.settings.titleModelRef = this.plugin.settings.defaultModelRef;
				}
				await this.plugin.saveSettings();
				this.display();
			},
		).open();

		// Re-render the settings tab once the modal closes so the row reflects any new state.
		this.scheduleRedisplayOnNextTick();
	}

	private openAddEndpointFlow(): void {
		new AddEndpointModal(this.app, async (template: EndpointTemplate) => {
			const id = newEndpointId(this.plugin.settings.endpoints);
			// OpenRouter inherits DEFAULT_MODEL_LIST via defaultOpenRouterEndpoint;
			// other templates carry their own curated models inline.
			const isOpenRouterTemplate = template.baseURL.includes('openrouter.ai');
			const newEndpoint: Endpoint = isOpenRouterTemplate
				? defaultOpenRouterEndpoint('', undefined)
				: {
						id,
						name: template.name === 'Custom' ? 'New endpoint' : template.name,
						baseURL: template.baseURL,
						apiKey: '',
						...(template.models ? { models: [...template.models] } : {}),
				  };
			if (isOpenRouterTemplate) {
				// defaultOpenRouterEndpoint hardcodes id 'openrouter'; rebind to a unique id
				// to allow multiple OpenRouter endpoints (e.g., a personal + a work key).
				newEndpoint.id = id;
				if (template.name && template.name !== 'OpenRouter') newEndpoint.name = template.name;
			}
			this.plugin.settings.endpoints.push(newEndpoint);
			await this.plugin.saveSettings();
			this.display();
			this.openEndpointEditor(newEndpoint);
		}).open();
	}

	private scheduleRedisplayOnNextTick(): void {
		// Modal.onClose fires before the next event loop tick; defer redraw so the row
		// reflects the user's last edits and any discovered models.
		window.setTimeout(() => this.display(), 0);
	}

	private renderModelDefaults(root: HTMLElement): void {
		new Setting(root).setName('Models').setHeading();

		root.createDiv({
			cls: 'setting-item-description vk-section-blurb',
			text: 'Pick from any model across the endpoints above.',
		});

		const { settings } = this.plugin;

		new Setting(root)
			.setName('Default chat model')
			.setDesc('Used when starting a new chat.')
			.addButton((btn) =>
				btn.setButtonText(describeModelRef(settings, settings.defaultModelRef)).onClick(() => {
					const wasMirroring = sameRef(settings.titleModelRef, settings.defaultModelRef);
					this.openPickerForRef(settings.defaultModelRef, (picked) => {
						settings.defaultModelRef = picked;
						if (wasMirroring) settings.titleModelRef = picked;
						void this.plugin.saveSettings();
						this.display();
					});
				}),
			);

		const titleSetting = new Setting(root)
			.setName('Title model')
			.setDesc('Cheap model used to auto-title chats after the first exchange.');

		if (sameRef(settings.titleModelRef, settings.defaultModelRef)) {
			titleSetting.controlEl.createSpan({ cls: 'vk-title-same', text: 'Same as chat model' });
			titleSetting.addButton((btn) =>
				btn.setButtonText('Customize…').onClick(() => {
					this.openPickerForRef(settings.titleModelRef, (picked) => {
						settings.titleModelRef = picked;
						void this.plugin.saveSettings();
						this.display();
					});
				}),
			);
		} else {
			titleSetting.addButton((btn) =>
				btn.setButtonText(describeModelRef(settings, settings.titleModelRef)).onClick(() => {
					this.openPickerForRef(settings.titleModelRef, (picked) => {
						settings.titleModelRef = picked;
						void this.plugin.saveSettings();
						this.display();
					});
				}),
			);
			titleSetting.addExtraButton((btn) =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip('Mirror chat model')
					.onClick(() => {
						settings.titleModelRef = { ...settings.defaultModelRef };
						void this.plugin.saveSettings();
						this.display();
					}),
			);
		}
	}

	private openPickerForRef(current: ModelRef, onPick: (ref: ModelRef) => void): void {
		new ModelPickerModal(
			this.app,
			this.plugin.settings.endpoints,
			current,
			this.plugin.settings.modelRecents,
			onPick,
		).open();
	}

	private renderSystemPromptSection(root: HTMLElement): void {
		new Setting(root).setName('System prompt').setHeading();

		const details = root.createEl('details', { cls: 'vk-prompt-details' });
		const summary = details.createEl('summary', { cls: 'vk-prompt-summary' });
		summary.createSpan({ cls: 'vk-prompt-preview', text: previewSystemPrompt(this.plugin.settings.systemPrompt) });
		summary.createSpan({ cls: 'vk-prompt-summary-action', text: 'Edit prompt' });

		const body = details.createDiv({ cls: 'vk-prompt-body' });
		new Setting(body)
			.setDesc('Sent at the start of every chat. Skill manifest appended automatically.')
			.addExtraButton((btn) =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		const textarea = body.createEl('textarea', { cls: 'vk-settings-textarea' });
		textarea.rows = 14;
		textarea.value = this.plugin.settings.systemPrompt;
		textarea.addEventListener('input', () => {
			this.plugin.settings.systemPrompt = textarea.value;
			void this.plugin.saveSettings();
		});
	}
}

function describeModelRef(settings: SmartAideSettings, ref: ModelRef): string {
	const endpoint = findEndpoint(settings, ref.endpointId);
	const friendly = friendlyModelName(ref.slug);
	if (settings.endpoints.length <= 1) return friendly;
	return `${friendly} · ${endpoint?.name ?? ref.endpointId}`;
}

function previewSystemPrompt(prompt: string): string {
	const flat = prompt.replace(/\s+/g, ' ').trim();
	return flat.length > 120 ? flat.slice(0, 117) + '…' : flat;
}

export { DEFAULT_SYSTEM_PROMPT };
export type { DiscoveredModel };
