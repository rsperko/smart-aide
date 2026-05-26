import { Notice, Setting } from 'obsidian';
import {
	SAMPLE_SKILLS,
	SampleInstallState,
	SampleSkill,
	installSample,
	readSampleStatus,
} from './sample-skills';
import { skillsDirFor } from './settings';
import type { SectionContext } from './settings-section';

export const SKILLS_TRUST_NOTE =
	'Skill bodies are trusted prompt content — they can redirect the model, ' +
	'restrict tools, or carry hidden instructions. Review any skill you install ' +
	'from outside this vault before loading it.';

export function renderSkills(root: HTMLElement, ctx: SectionContext): void {
	const renderGen = ctx.currentRenderGen();
	const heading = new Setting(root).setName('Skills').setHeading();
	heading.settingEl.setAttribute('data-section', 'skills');

	root.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text:
			'Skills are markdown files with YAML frontmatter (name + description). Their descriptions are injected into the system prompt; the model loads a body on demand via load_skill(name) when a request matches. Same path on desktop and mobile — both read from the vault.',
	});

	root.createDiv({
		cls: 'vk-skills-trust-note',
		text: SKILLS_TRUST_NOTE,
	});

	const count = ctx.plugin.skills.all().length;
	const summary = root.createDiv({ cls: 'vk-skills-summary' });
	summary.createSpan({
		cls: 'vk-skills-count',
		text: `${count} skill${count === 1 ? '' : 's'} installed`,
	});
	summary.createSpan({
		cls: 'vk-skills-hint',
		text: 'Use Vault data → Reload after creating or editing skills.',
	});

	renderStartersBlock(root, ctx, renderGen);
}

function renderStartersBlock(root: HTMLElement, ctx: SectionContext, capturedGen: number): void {
	const block = root.createDiv({ cls: 'vk-starters-block' });
	new Setting(block).setName('Starter skills').setHeading();

	block.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text:
			'Drop in a starter skill to learn the format and customize for your vault. ' +
			'Each install writes a markdown file to your skills folder. Re-installing a customized file saves your version as a .bak first.',
	});

	const skillsDir = skillsDirFor(ctx.plugin.settings.metaDir);
	const rowActionEls: HTMLElement[] = [];

	for (const skill of SAMPLE_SKILLS) {
		const row = block.createDiv({ cls: 'vk-sample-skill-row' });
		const head = row.createDiv({ cls: 'vk-sample-skill-head' });

		const meta = head.createDiv({ cls: 'vk-sample-skill-meta' });
		meta.createDiv({ cls: 'vk-sample-skill-name', text: skill.name });
		meta.createDiv({ cls: 'vk-sample-skill-desc', text: skill.shortDescription });
		meta.createDiv({
			cls: 'vk-sample-skill-model',
			text: `Recommended model: ${skill.recommendedModel}`,
		});

		const actions = head.createDiv({ cls: 'vk-sample-skill-actions' });
		actions.createSpan({ cls: 'vk-sample-skill-checking', text: 'checking…' });
		rowActionEls.push(actions);

		const details = row.createEl('details', { cls: 'vk-sample-skill-preview' });
		details.createEl('summary', { text: 'Preview' });
		details.createEl('pre').createEl('code', { text: skill.body });
	}

	const footer = block.createDiv({ cls: 'vk-sample-skill-footer' });
	const allBtn = footer.createEl('button', {
		cls: 'mod-cta',
		text: `Install all ${SAMPLE_SKILLS.length}`,
	});
	allBtn.addEventListener('click', async () => {
		let created = 0;
		let unchanged = 0;
		let kept = 0;
		for (const skill of SAMPLE_SKILLS) {
			const result = await installSample(ctx.plugin.app.vault, skillsDir, skill);
			if (result.status === 'created') created++;
			else if (result.status === 'unchanged') unchanged++;
			else kept++;
		}
		const parts: string[] = [];
		if (created) parts.push(`installed ${created}`);
		if (unchanged) parts.push(`${unchanged} already current`);
		if (kept) parts.push(`${kept} kept (customized — use Reset sample to overwrite)`);
		new Notice(parts.length ? parts.join(' · ') : 'Nothing to do.');
		await ctx.plugin.skills.load();
		ctx.plugin.refreshOpenViewProjections();
		ctx.redisplay();
	});

	// Resolve per-row install status in the background so the section paints
	// immediately. The captured renderGen guards against a stale paint writing
	// into freshly-rendered DOM after redisplay.
	void (async () => {
		const statuses = await Promise.all(
			SAMPLE_SKILLS.map((skill) =>
				readSampleStatus(ctx.plugin.app.vault, skillsDir, skill).catch(() => null),
			),
		);
		if (capturedGen !== ctx.currentRenderGen()) return;
		for (let i = 0; i < SAMPLE_SKILLS.length; i++) {
			const skill = SAMPLE_SKILLS[i];
			const actions = rowActionEls[i];
			if (!actions.isConnected) continue;
			const status = statuses[i];
			actions.empty();
			if (status) {
				renderSampleSkillAction(actions, skill, status, skillsDir, ctx);
			} else {
				actions.createSpan({ text: 'unavailable' });
			}
		}
	})();
}

function renderSampleSkillAction(
	actions: HTMLElement,
	skill: SampleSkill,
	status: { state: SampleInstallState; path: string },
	skillsDir: string,
	ctx: SectionContext,
): void {
	const install = async (overwrite: boolean): Promise<void> => {
		try {
			const result = await installSample(ctx.plugin.app.vault, skillsDir, skill, { overwrite });
			if (result.status === 'created') {
				new Notice(`Installed ${skill.name}.`);
			} else if (result.status === 'overwritten') {
				new Notice(`Reset ${skill.name} to bundled version. Your version saved to ${result.backupPath}.`);
			} else if (result.status === 'unchanged') {
				new Notice(`${skill.name} is already up to date.`);
			}
			await ctx.plugin.skills.load();
			ctx.plugin.refreshOpenViewProjections();
			ctx.redisplay();
		} catch (e) {
			new Notice(`Failed to install ${skill.name}: ${(e as Error).message}`);
		}
	};

	if (status.state === 'not-installed') {
		const btn = actions.createEl('button', { cls: 'mod-cta', text: 'Install' });
		btn.addEventListener('click', () => void install(false));
		return;
	}

	const label = actions.createSpan({
		cls: 'vk-sample-skill-installed',
		text: status.state === 'installed-current' ? 'Installed ✓' : 'Installed · customized',
	});
	if (status.state === 'installed-modified') {
		label.addClass('vk-sample-skill-installed-modified');
	}

	const openLink = actions.createEl('a', {
		cls: 'vk-sample-skill-open',
		text: 'Open',
		href: '#',
	});
	openLink.addEventListener('click', (ev) => {
		ev.preventDefault();
		void ctx.plugin.app.workspace.openLinkText(status.path, '', false);
	});

	if (status.state === 'installed-modified') {
		const btn = actions.createEl('button', { cls: 'mod-warning', text: 'Reset sample' });
		btn.title = 'Overwrites your edits. Your current copy will be saved as <name>.md.bak.';
		btn.addEventListener('click', () => {
			const ok = window.confirm(
				`Your ${skill.name}.md is customized. Resetting will save your version as ${skill.name}.md.bak and replace the file with the bundled sample. Continue?`,
			);
			if (ok) void install(true);
		});
	}
}
