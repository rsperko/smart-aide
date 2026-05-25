import {
	describeModelRef,
	endpointSummary,
	isEndpointConnected,
} from './settings';
import type { SmartAideSettings } from './settings';
import type { SectionContext, SectionId } from './settings-section';

export interface OverviewInput {
	settings: SmartAideSettings;
	installedSkillCount: number;
	sampleTotal: number;
	agentsFound: boolean;
}

export type BannerId = 'no-key' | 'test-failed' | 'no-favorites';

export interface OverviewAction {
	label: string;
	href?: string;
	sectionId?: SectionId;
}

export interface OverviewBanner {
	id: BannerId;
	title: string;
	body?: string;
	primaryAction: OverviewAction;
	secondaryAction?: OverviewAction;
}

export type RowId = 'providers' | 'chatModels' | 'favorites' | 'vaultData' | 'skills' | 'safety';

export interface OverviewRow {
	id: RowId;
	label: string;
	status: string;
	tone: 'ok' | 'warn';
	actionLabel: string;
	scrollTo: SectionId;
}

export interface OverviewModel {
	banner: OverviewBanner | null;
	rows: OverviewRow[];
}

export function buildOverview(input: OverviewInput): OverviewModel {
	return {
		banner: buildBanner(input),
		rows: [
			providersRow(input),
			chatModelRow(input),
			favoritesRow(input),
			vaultDataRow(input),
			skillsRow(input),
			safetyRow(input),
		],
	};
}

function buildBanner(input: OverviewInput): OverviewBanner | null {
	const { settings } = input;
	const anyKey = settings.endpoints.some((e) => Boolean(e.apiKey));
	if (!anyKey) {
		return {
			id: 'no-key',
			title: 'Add an API key to start chatting',
			body: 'OpenRouter is the easiest — one key, every major model, pay-as-you-go.',
			primaryAction: { label: 'Get an OpenRouter key →', href: 'https://openrouter.ai/keys' },
			secondaryAction: { label: 'I already have one', sectionId: 'providers' },
		};
	}

	const failed = settings.endpoints.find((e) => e.apiKey && e.lastTest && !e.lastTest.ok);
	if (failed) {
		const reason = failed.lastTest?.message ?? 'connection test failed';
		return {
			id: 'test-failed',
			title: `${failed.name || failed.id} didn't connect`,
			body: reason,
			primaryAction: { label: 'Open provider', sectionId: 'providers' },
		};
	}

	if (settings.favoriteModels.length === 0) {
		return {
			id: 'no-favorites',
			title: 'Pin at least one favorite to use the chat picker',
			primaryAction: { label: 'Browse all models →', sectionId: 'chatModels' },
		};
	}

	return null;
}

function providersRow(input: OverviewInput): OverviewRow {
	const { endpoints } = input.settings;
	const anyKey = endpoints.some((e) => Boolean(e.apiKey));
	if (!anyKey) {
		const count = endpoints.length;
		return {
			id: 'providers',
			label: 'Providers',
			status: `${count} configured · no keys yet`,
			tone: 'warn',
			actionLabel: 'Manage →',
			scrollTo: 'providers',
		};
	}

	const primary = endpoints.find(isEndpointConnected) ?? endpoints.find((e) => Boolean(e.apiKey))!;
	return {
		id: 'providers',
		label: 'Providers',
		status: `${primary.name || primary.id} · ${endpointSummary(primary)}`,
		tone: 'ok',
		actionLabel: 'Manage →',
		scrollTo: 'providers',
	};
}

function chatModelRow(input: OverviewInput): OverviewRow {
	const { settings } = input;
	const noFavorites = settings.favoriteModels.length === 0;
	return {
		id: 'chatModels',
		label: 'Chat model',
		status: noFavorites ? '—' : describeModelRef(settings, settings.defaultModelRef),
		tone: noFavorites ? 'warn' : 'ok',
		actionLabel: noFavorites ? 'Choose →' : 'Change →',
		scrollTo: 'chatModels',
	};
}

function favoritesRow(input: OverviewInput): OverviewRow {
	const count = input.settings.favoriteModels.length;
	let status: string;
	if (count === 0) status = 'None pinned';
	else if (count === 1) status = '1 model pinned';
	else status = `${count} models pinned`;
	return {
		id: 'favorites',
		label: 'Favorites',
		status,
		tone: count === 0 ? 'warn' : 'ok',
		actionLabel: 'Browse all →',
		scrollTo: 'chatModels',
	};
}

function vaultDataRow(input: OverviewInput): OverviewRow {
	const meta = input.settings.metaDir;
	const suffix = input.agentsFound ? 'AGENTS.md found' : 'no AGENTS.md';
	return {
		id: 'vaultData',
		label: 'Vault data',
		status: `${meta}/ · ${suffix}`,
		tone: 'ok',
		actionLabel: 'Open →',
		scrollTo: 'vaultData',
	};
}

function skillsRow(input: OverviewInput): OverviewRow {
	const { installedSkillCount, sampleTotal } = input;
	if (installedSkillCount === 0 && sampleTotal > 0) {
		return {
			id: 'skills',
			label: 'Skills',
			status: `0 installed · ${sampleTotal} starters available`,
			tone: 'warn',
			actionLabel: 'Install starters',
			scrollTo: 'skills',
		};
	}
	return {
		id: 'skills',
		label: 'Skills',
		status: `${installedSkillCount} installed`,
		tone: 'ok',
		actionLabel: 'Manage →',
		scrollTo: 'skills',
	};
}

function safetyRow(input: OverviewInput): OverviewRow {
	if (input.settings.autoApproveWrites) {
		return {
			id: 'safety',
			label: 'Safety',
			status: '⚠ Auto-approve writes ON',
			tone: 'warn',
			actionLabel: 'Configure →',
			scrollTo: 'safety',
		};
	}
	return {
		id: 'safety',
		label: 'Safety',
		status: 'Writes require approval',
		tone: 'ok',
		actionLabel: 'Configure →',
		scrollTo: 'safety',
	};
}

export function renderOverview(root: HTMLElement, ctx: SectionContext, sampleTotal: number): void {
	const settings = ctx.plugin.settings;
	const model = buildOverview({
		settings,
		installedSkillCount: ctx.plugin.skills.all().length,
		sampleTotal,
		agentsFound: ctx.plugin.agents.text().length > 0,
	});

	const section = root.createDiv({ cls: 'vk-overview' });
	section.setAttribute('data-section', 'overview');

	section.createEl('h2', { cls: 'vk-overview-heading', text: 'Overview' });

	if (model.banner) renderBanner(section, model.banner, ctx);

	const list = section.createDiv({ cls: 'vk-overview-list' });
	for (const row of model.rows) {
		renderRow(list, row, ctx);
	}
}

function renderBanner(parent: HTMLElement, banner: OverviewBanner, ctx: SectionContext): void {
	const card = parent.createDiv({ cls: 'vk-overview-banner' });
	card.createDiv({ cls: 'vk-overview-banner-title', text: `⚠  ${banner.title}` });
	if (banner.body) card.createDiv({ cls: 'vk-overview-banner-body', text: banner.body });

	const actions = card.createDiv({ cls: 'vk-overview-banner-actions' });
	renderBannerAction(actions, banner.primaryAction, true, ctx);
	if (banner.secondaryAction) {
		renderBannerAction(actions, banner.secondaryAction, false, ctx);
	}
}

function renderBannerAction(
	parent: HTMLElement,
	action: OverviewAction,
	primary: boolean,
	ctx: SectionContext,
): void {
	const btn = parent.createEl('button', { text: action.label });
	if (primary) btn.addClass('mod-cta');
	btn.addEventListener('click', () => {
		if (action.href) {
			window.open(action.href, '_blank');
			return;
		}
		if (action.sectionId) ctx.scrollToSection(action.sectionId);
	});
}

function renderRow(parent: HTMLElement, row: OverviewRow, ctx: SectionContext): void {
	const el = parent.createDiv({ cls: `vk-overview-row vk-overview-row-${row.tone}` });
	el.createDiv({ cls: 'vk-overview-row-label', text: row.label });
	el.createDiv({ cls: 'vk-overview-row-status', text: row.status });

	const action = el.createEl('button', { cls: 'vk-overview-row-action', text: row.actionLabel });
	action.addEventListener('click', () => ctx.scrollToSection(row.scrollTo));
}
