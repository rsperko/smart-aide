import { Setting } from 'obsidian';
import { DEFAULT_SYSTEM_PROMPT, previewSystemPrompt } from './settings';
import type { SmartAideSettings } from './settings';
import type { SectionContext } from './settings-section';

/**
 * Mirrors view.ts:composeSystemPrompt so the Advanced preview shows the model
 * exactly what gets sent every turn — base prompt, then AGENTS.md framing,
 * then the skill manifest. Pure so it can be unit-tested cold.
 */
export function composedSystemPromptPreview(
	base: string,
	agentsBody: string,
	manifest: string,
): string {
	const sections: string[] = [base];
	if (agentsBody) sections.push(`Vault context (user-maintained):\n\n${agentsBody}`);
	if (manifest) sections.push(manifest);
	return sections.join('\n\n');
}

export function renderAdvanced(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Advanced').setHeading();
	heading.settingEl.setAttribute('data-section', 'advanced');

	renderSystemPromptBlock(root, ctx);
	renderProviderBehaviorBlock(root, ctx);
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
		.setDesc('Sent at the start of every chat. AGENTS.md and the skill manifest are appended automatically — see the composed preview below.')
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

// Re-export the settings type so callers wiring composedSystemPromptPreview
// against settings don't need a second import.
export type { SmartAideSettings };
