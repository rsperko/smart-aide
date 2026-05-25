import { Notice, Setting } from 'obsidian';
import {
	DEFAULT_META_DIR,
	chatsDirFor,
	internalDirFor,
	normalizeMetaDir,
	skillsDirFor,
} from './settings';
import type { SectionContext } from './settings-section';

export interface DerivedPaths {
	chats: string;
	skills: string;
	internals: string;
	agentsMd: string;
}

export function derivedPathLabels(metaDir: string): DerivedPaths {
	return {
		chats: chatsDirFor(metaDir),
		skills: skillsDirFor(metaDir),
		internals: internalDirFor(metaDir),
		agentsMd: `${metaDir}/AGENTS.md`,
	};
}

export function renderVaultData(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Vault data').setHeading();
	heading.settingEl.setAttribute('data-section', 'vaultData');

	root.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text:
			'Vault-relative folder where Smart Aide stores its content. Chats, skills, plugin internals, and the optional AGENTS.md vault-context file all live here. Default: Meta. Common alternative: sys.',
	});

	new Setting(root)
		.setName('Meta folder')
		.setDesc('Changing this changes where Smart Aide looks — it does not move existing chats or skills.')
		.addText((t) =>
			t
				.setPlaceholder(DEFAULT_META_DIR)
				.setValue(ctx.plugin.settings.metaDir)
				.onChange(async (v) => {
					const next = normalizeMetaDir(v);
					ctx.plugin.settings.metaDir = next;
					await ctx.plugin.saveSettings();
					ctx.plugin.storage.setDir(chatsDirFor(next));
					ctx.plugin.skills.setDir(skillsDirFor(next));
					ctx.plugin.agents.setDir(next);
					await Promise.all([ctx.plugin.skills.load(), ctx.plugin.agents.load()]);
					ctx.plugin.refreshOpenViewProjections();
					ctx.redisplay();
				}),
		);

	const paths = derivedPathLabels(ctx.plugin.settings.metaDir);
	const agentsFound = ctx.plugin.agents.text().length > 0;
	const grid = root.createDiv({ cls: 'vk-paths-grid' });
	addPathRow(grid, 'Chats', paths.chats);
	addPathRow(grid, 'Skills', paths.skills);
	addPathRow(grid, 'Plugin internals', paths.internals);
	addPathRow(grid, 'Vault context', `${paths.agentsMd} — ${agentsFound ? 'found' : 'not found'}`);

	new Setting(root)
		.setName('Reload skills & AGENTS.md')
		.setDesc('Re-scan the skills directory and re-read AGENTS.md after editing either.')
		.addButton((btn) =>
			btn.setButtonText('Reload').onClick(async () => {
				await Promise.all([ctx.plugin.skills.load(), ctx.plugin.agents.load()]);
				ctx.plugin.refreshOpenViewProjections();
				const count = ctx.plugin.skills.all().length;
				new Notice(`Loaded ${count} skill${count === 1 ? '' : 's'}.`);
				ctx.redisplay();
			}),
		);
}

function addPathRow(parent: HTMLElement, label: string, value: string): void {
	const row = parent.createDiv({ cls: 'vk-paths-row' });
	row.createSpan({ cls: 'vk-paths-label', text: label });
	row.createSpan({ cls: 'vk-paths-value', text: value });
}
