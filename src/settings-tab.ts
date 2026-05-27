import { App, PluginSettingTab } from 'obsidian';
import { renderEndpointEditor } from './endpoint-editor';
import { findEndpoint, removeEndpoint } from './settings';
import type { SectionContext, SectionId } from './settings-section';
import { renderOverview } from './settings-overview';
import { renderProviders } from './settings-providers';
import { renderChatModels } from './settings-models';
import { renderVaultData } from './settings-vault-data';
import { renderSkills } from './settings-skills';
import { renderSafety } from './settings-safety';
import { renderAdvanced } from './settings-advanced';
import { SAMPLE_SKILLS } from './sample-skills';
import type SmartAidePlugin from './main';

export class SmartAideSettingsTab extends PluginSettingTab {
	private editingEndpointId: string | null = null;
	private renderGen = 0;

	constructor(app: App, private plugin: SmartAidePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.renderGen++;

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
					this.plugin.settings = removeEndpoint(this.plugin.settings, endpoint.id);
					await this.plugin.saveSettings();
					this.editingEndpointId = null;
					this.display();
				},
			});
			return;
		}

		const ctx: SectionContext = {
			app: this.app,
			plugin: this.plugin,
			redisplay: () => this.display(),
			enterEndpointEditor: (id) => {
				this.editingEndpointId = id;
				this.display();
			},
			scrollToSection: (id) => this.scrollToSection(id),
			currentRenderGen: () => this.renderGen,
		};

		renderOverview(containerEl, ctx, SAMPLE_SKILLS.length);
		renderProviders(containerEl, ctx);
		renderChatModels(containerEl, ctx);
		renderVaultData(containerEl, ctx);
		renderSkills(containerEl, ctx);
		renderSafety(containerEl, ctx);
		renderAdvanced(containerEl, ctx);
	}

	private scrollToSection(id: SectionId): void {
		const target = this.containerEl.querySelector(`[data-section="${id}"]`);
		if (target instanceof HTMLElement) {
			target.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}
}
