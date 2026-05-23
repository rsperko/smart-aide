import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { ModelRef, Endpoint } from './types';
import { ModelPickerModal } from './picker-models';
import { renderEndpointEditor } from './endpoint-editor';
import { AddEndpointModal, EndpointTemplate } from './modal-add-endpoint';
import {
	DEFAULT_META_DIR,
	DEFAULT_SYSTEM_PROMPT,
	chatsDirFor,
	defaultOpenRouterEndpoint,
	describeModelRef,
	endpointSummary,
	findEndpoint,
	isEndpointConnected,
	newEndpointId,
	normalizeMetaDir,
	pickReplacementModelRef,
	previewSystemPrompt,
	sameRef,
	skillsDirFor,
} from './settings';
import type SmartAidePlugin from './main';

export class SmartAideSettingsTab extends PluginSettingTab {
	private editingEndpointId: string | null = null;

	constructor(app: App, private plugin: SmartAidePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		if (this.editingEndpointId !== null) {
			const endpoint = findEndpoint(this.plugin.settings, this.editingEndpointId);
			if (!endpoint) {
				this.editingEndpointId = null;
				this.display();
				return;
			}
			renderEndpointEditor(containerEl, endpoint, {
				app: this.app,
				saveSettings: () => this.plugin.saveSettings(),
				onChange: () => this.display(),
				onBack: () => {
					this.editingEndpointId = null;
					this.display();
				},
				onDelete: async () => {
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
					this.editingEndpointId = null;
					this.display();
				},
			});
			return;
		}

		this.renderEndpointsSection(containerEl);
		this.renderModelDefaults(containerEl);
		this.renderStorageSection(containerEl);
		this.renderSkillsSection(containerEl);
		this.renderApprovalSection(containerEl);
		this.renderSystemPromptSection(containerEl);
	}

	private renderStorageSection(root: HTMLElement): void {
		new Setting(root).setName('Storage').setHeading();

		root.createDiv({
			cls: 'setting-item-description vk-section-blurb',
			text:
				'Vault-relative folder where Smart Aide stores its content. Chats live under {meta}/chats, skills under {meta}/skills, plugin internals under {meta}/.smart-aide. Default: Meta. Common alternative: sys.',
		});

		new Setting(root)
			.setName('Meta folder')
			.setDesc('Change here to keep your existing chats and skills wired up if you previously used a different folder.')
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_META_DIR)
					.setValue(this.plugin.settings.metaDir)
					.onChange(async (v) => {
						const next = normalizeMetaDir(v);
						this.plugin.settings.metaDir = next;
						await this.plugin.saveSettings();
						this.plugin.storage.setDir(chatsDirFor(next));
						this.plugin.skills.setDir(skillsDirFor(next));
						this.plugin.agents.setDir(next);
						await Promise.all([this.plugin.skills.load(), this.plugin.agents.load()]);
					}),
			);

		root.createDiv({
			cls: 'setting-item-description vk-section-blurb',
			text:
				`Optional: a Markdown file at {meta}/AGENTS.md (e.g. ${this.plugin.settings.metaDir}/AGENTS.md) is appended to the system prompt as vault context — layout, tag conventions, projects, paths to avoid. Standard cross-tool format (agents.md). Reload with the button below after edits.`,
		});
	}

	private renderSkillsSection(root: HTMLElement): void {
		new Setting(root).setName('Skills').setHeading();

		root.createDiv({
			cls: 'setting-item-description vk-section-blurb',
			text:
				'Skills are markdown files with YAML frontmatter (name + description) under {meta}/skills. Their descriptions are injected into the system prompt; the model loads a body on demand via load_skill(name) when a user request matches the description. Same path on desktop and mobile — both read from the vault.',
		});

		new Setting(root)
			.setName('Reload skills & AGENTS.md')
			.setDesc('Re-scan the skills directory and re-read AGENTS.md. Run after creating or editing either.')
			.addButton((btn) =>
				btn.setButtonText('Reload').onClick(async () => {
					await Promise.all([this.plugin.skills.load(), this.plugin.agents.load()]);
					const count = this.plugin.skills.all().length;
					new Notice(`Loaded ${count} skill${count === 1 ? '' : 's'}.`);
				}),
			);
	}

	private renderApprovalSection(root: HTMLElement): void {
		new Setting(root).setName('Approvals').setHeading();

		new Setting(root)
			.setName('Auto-approve writes (dangerous)')
			.setDesc(
				'Skip the diff approval card for write_note and append_to_note — the model can edit your vault without confirmation. ' +
				'Deletes still require explicit approval regardless of this setting. ' +
				'When on, a ⚠ chip appears in the chat top bar so it stays visible.',
			)
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.autoApproveWrites).onChange(async (v) => {
					this.plugin.settings.autoApproveWrites = v;
					await this.plugin.saveSettings();
					this.plugin.refreshDangerChips();
				}),
			);
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
		this.editingEndpointId = endpoint.id;
		this.display();
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
