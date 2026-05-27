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

	new Setting(root)
		.setName('Cost cap per turn (USD)')
		.setDesc(
			'Block send when the next-turn projected cost exceeds this value. ' +
			'Compared against the same projection shown in the token chip popover. ' +
			'Endpoints without pricing (LM Studio, custom gateways) never trip the cap. ' +
			'0 = off.',
		)
		.addText((t) => {
			t.inputEl.type = 'number';
			t.inputEl.min = '0';
			t.inputEl.step = '0.01';
			t.inputEl.placeholder = '0';
			t.setValue(String(ctx.plugin.settings.costCapPerTurnUsd ?? 0));
			t.onChange(async (raw) => {
				const n = Number(raw);
				ctx.plugin.settings.costCapPerTurnUsd = Number.isFinite(n) && n > 0 ? n : 0;
				await ctx.plugin.saveSettings();
			});
		});
}
