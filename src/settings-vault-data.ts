import { Notice, Setting } from 'obsidian';
import {
	DEFAULT_META_DIR,
	chatsDirFor,
	internalDirFor,
	memoryFileFor,
	normalizeMetaDir,
	skillsDirFor,
} from './settings';
import type { SectionContext } from './settings-section';

export interface DerivedPaths {
	chats: string;
	skills: string;
	internals: string;
	agentsMd: string;
	memory: string;
}

export function derivedPathLabels(metaDir: string): DerivedPaths {
	return {
		chats: chatsDirFor(metaDir),
		skills: skillsDirFor(metaDir),
		internals: internalDirFor(metaDir),
		agentsMd: `${metaDir}/AGENTS.md`,
		memory: memoryFileFor(metaDir),
	};
}

export function renderVaultData(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Vault data').setHeading();
	heading.settingEl.setAttribute('data-section', 'vaultData');

	root.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text:
			'Vault-relative folder Smart Aide reads from. Cross-tool standards (skills, AGENTS.md) sit at the root so other agents — Pi, Claude Code, Codex — can read the same files. Plugin-only state (chats, memory, internals) nests under a `Smart Aide/` subfolder so the file tree shows what belongs to the plugin vs your notes. Default: Meta. Common alternative: sys.',
	});

	new Setting(root)
		.setName('Meta folder')
		.setDesc('Changing this changes where Smart Aide looks — it does not move existing chats, skills, or memory.')
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
					ctx.plugin.memory.setDir(next);
					await Promise.all([
						ctx.plugin.skills.load(),
						ctx.plugin.agents.load(),
						ctx.plugin.memory.load(),
					]);
					ctx.plugin.refreshOpenViewProjections();
					ctx.redisplay();
				}),
		);

	const paths = derivedPathLabels(ctx.plugin.settings.metaDir);
	const agentsFound = ctx.plugin.agents.text().length > 0;
	const memoryFound = ctx.plugin.memory.text().length > 0;
	const grid = root.createDiv({ cls: 'vk-paths-grid' });
	addPathRow(grid, 'Skills', `${paths.skills} (cross-tool)`);
	addPathRow(grid, 'Vault context', `${paths.agentsMd} — ${agentsFound ? 'found' : 'not found'} (cross-tool)`);
	addPathRow(grid, 'Chats', paths.chats);
	addPathRow(grid, 'Memory', `${paths.memory} — ${memoryFound ? 'found' : 'not found'}`);
	addPathRow(grid, 'Plugin internals', paths.internals);

	new Setting(root)
		.setName('Reload skills, AGENTS.md & memory')
		.setDesc('Re-scan the skills directory and re-read AGENTS.md and memory.md after editing any of them.')
		.addButton((btn) =>
			btn.setButtonText('Reload').onClick(async () => {
				await Promise.all([
					ctx.plugin.skills.load(),
					ctx.plugin.agents.load(),
					ctx.plugin.memory.load(),
				]);
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
