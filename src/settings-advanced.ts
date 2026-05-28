import { Notice, Setting } from 'obsidian';
import { DEFAULT_SYSTEM_PROMPT, previewSystemPrompt } from './settings';
import type { SmartAideSettings } from './settings';
import type { SectionContext } from './settings-section';

/**
 * Mirrors view.ts:composeSystemPrompt so the Advanced preview shows the model
 * exactly what gets sent every turn — base prompt, AGENTS.md framing,
 * persistent memory, then the skill manifest. Pure so it can be unit-tested cold.
 */
export function composedSystemPromptPreview(
	base: string,
	agentsBody: string,
	memoryBody: string,
	manifest: string,
): string {
	const sections: string[] = [base];
	if (agentsBody) sections.push(`Vault context (user-maintained):\n\n${agentsBody}`);
	if (memoryBody) {
		sections.push(`Persistent memory (your prior saves — call save_memory to extend):\n\n${memoryBody}`);
	}
	if (manifest) sections.push(manifest);
	return sections.join('\n\n');
}

export function renderAdvanced(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Advanced').setHeading();
	heading.settingEl.setAttribute('data-section', 'advanced');

	renderSystemPromptBlock(root, ctx);
	renderProviderBehaviorBlock(root, ctx);
	renderResetDeviceBlock(root, ctx);
}

function renderSystemPromptBlock(root: HTMLElement, ctx: SectionContext): void {
	const details = root.createEl('details', { cls: 'vk-prompt-details' });
	const summary = details.createEl('summary', { cls: 'vk-prompt-summary' });
	summary.createSpan({ cls: 'vk-prompt-summary-label', text: 'System prompt' });
	summary.createSpan({
		cls: 'vk-prompt-preview',
		text: previewSystemPrompt(ctx.plugin.settings.systemPrompt),
	});

	const body = details.createDiv({ cls: 'vk-prompt-body' });
	new Setting(body)
		.setDesc('Sent at the start of every chat. AGENTS.md, persistent memory, and the skill manifest are appended automatically — see the composed preview below.')
		.addExtraButton((btn) =>
			btn
				.setIcon('rotate-ccw')
				.setTooltip('Reset to default')
				.onClick(async () => {
					ctx.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
					await ctx.plugin.saveSettings();
					ctx.redisplay();
				}),
		);

	const textarea = body.createEl('textarea', { cls: 'vk-settings-textarea' });
	textarea.rows = 14;
	textarea.value = ctx.plugin.settings.systemPrompt;
	textarea.addEventListener('input', () => {
		ctx.plugin.settings.systemPrompt = textarea.value;
		void ctx.plugin.saveSettings();
	});
}

function renderProviderBehaviorBlock(root: HTMLElement, ctx: SectionContext): void {
	new Setting(root)
		.setName('Anthropic prompt caching')
		.setDesc(
			'On Anthropic-native endpoints only: marks the system prompt + tool definitions as ephemeral cache. ~90% off cached reads after the first turn. (OpenAI-compat endpoints ignore this; Gemini-native uses implicit caching.)',
		)
		.addToggle((tg) =>
			tg.setValue(ctx.plugin.settings.anthropicPromptCaching).onChange(async (v) => {
				ctx.plugin.settings.anthropicPromptCaching = v;
				await ctx.plugin.saveSettings();
			}),
		);
}

function renderResetDeviceBlock(root: HTMLElement, ctx: SectionContext): void {
	const setting = new Setting(root)
		.setName('Reset device settings')
		.setDesc(
			'Wipes this device’s per-device data from localStorage: providers, API keys, favorites, default + title model, and safety toggles. Chats, skills, AGENTS.md, persistent memory, Meta folder path, and system prompt are not touched (they live in the vault or in data.json). Reload Obsidian after resetting.',
		);

	const btn = setting.controlEl.createEl('button', {
		cls: 'mod-warning',
		text: 'Reset device settings',
	});
	let confirming = false;
	let resetTimer: number | undefined;
	btn.addEventListener('click', () => {
		if (!confirming) {
			confirming = true;
			btn.setText('Click again to confirm');
			resetTimer = window.setTimeout(() => {
				confirming = false;
				btn.setText('Reset device settings');
			}, 3000);
			return;
		}
		if (resetTimer) window.clearTimeout(resetTimer);
		ctx.plugin.deviceStore.clear();
		ctx.plugin.keyStore.clear();
		new Notice('Device settings reset. Reload Obsidian to start fresh.');
	});
}

// Re-export the settings type so callers wiring composedSystemPromptPreview
// against settings don't need a second import.
export type { SmartAideSettings };
