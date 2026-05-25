import { Setting } from 'obsidian';
import type { SectionContext } from './settings-section';

export function renderSafety(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Safety').setHeading();
	heading.settingEl.setAttribute('data-section', 'safety');

	root.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text:
			'Writes (write_note, append_to_note) show a diff approval card by default — you pick which changes to apply. Deletes always confirm individually, regardless of any setting.',
	});

	new Setting(root)
		.setName('Auto-approve writes (dangerous)')
		.setDesc(
			'Skip the diff approval card for write_note and append_to_note — the model can edit your vault without confirmation. ' +
			'Deletes still require explicit approval. ' +
			'When on, a ⚠ chip appears in the chat top bar so the state stays visible.',
		)
		.addToggle((tg) =>
			tg.setValue(ctx.plugin.settings.autoApproveWrites).onChange(async (v) => {
				ctx.plugin.settings.autoApproveWrites = v;
				await ctx.plugin.saveSettings();
				ctx.plugin.refreshDangerChips();
			}),
		);
}
