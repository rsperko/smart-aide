import { Setting } from 'obsidian';
import { ModelRef } from './types';
import { BrowseAllPickerModal, FavoritesPickerModal } from './picker-models';
import {
	describeModelRef,
	moveFavorite,
	rebindDefaultsToFavorites,
	removeFavorite,
	sameRef,
} from './settings';
import type { SectionContext } from './settings-section';

export function renderChatModels(root: HTMLElement, ctx: SectionContext): void {
	const heading = new Setting(root).setName('Chat models').setHeading();
	heading.settingEl.setAttribute('data-section', 'chatModels');

	root.createDiv({
		cls: 'setting-item-description vk-section-blurb',
		text: 'Default chat model and title model are picked from your favorites. Browse all models to add new favorites.',
	});

	renderDefaultsRows(root, ctx);
	renderFavoritesList(root, ctx);
}

function renderDefaultsRows(root: HTMLElement, ctx: SectionContext): void {
	const { settings } = ctx.plugin;
	const hasFavorites = settings.favoriteModels.length > 0;

	const defaultSetting = new Setting(root)
		.setName('Default chat model')
		.setDesc('Used when starting a new chat.');

	if (!hasFavorites) {
		defaultSetting.controlEl.createSpan({ cls: 'vk-empty-hint', text: 'No favorites yet' });
	} else {
		defaultSetting.addButton((btn) =>
			btn.setButtonText(describeModelRef(settings, settings.defaultModelRef)).onClick(() => {
				const wasMirroring = sameRef(settings.titleModelRef, settings.defaultModelRef);
				openFavoritesPickerFor(ctx, settings.defaultModelRef, (picked) => {
					settings.defaultModelRef = picked;
					if (wasMirroring) settings.titleModelRef = picked;
					void ctx.plugin.saveSettings();
					ctx.redisplay();
				});
			}),
		);
	}

	const titleSetting = new Setting(root)
		.setName('Title model')
		.setDesc('Cheap model used to auto-title chats after the first exchange.');

	if (!hasFavorites) {
		titleSetting.controlEl.createSpan({ cls: 'vk-empty-hint', text: 'No favorites yet' });
	} else if (sameRef(settings.titleModelRef, settings.defaultModelRef)) {
		titleSetting.controlEl.createSpan({ cls: 'vk-title-same', text: 'Same as chat model' });
		titleSetting.addButton((btn) =>
			btn.setButtonText('Customize…').onClick(() => {
				openFavoritesPickerFor(ctx, settings.titleModelRef, (picked) => {
					settings.titleModelRef = picked;
					void ctx.plugin.saveSettings();
					ctx.redisplay();
				});
			}),
		);
	} else {
		titleSetting.addButton((btn) =>
			btn.setButtonText(describeModelRef(settings, settings.titleModelRef)).onClick(() => {
				openFavoritesPickerFor(ctx, settings.titleModelRef, (picked) => {
					settings.titleModelRef = picked;
					void ctx.plugin.saveSettings();
					ctx.redisplay();
				});
			}),
		);
		titleSetting.addExtraButton((btn) =>
			btn
				.setIcon('rotate-ccw')
				.setTooltip('Mirror chat model')
				.onClick(() => {
					settings.titleModelRef = { ...settings.defaultModelRef };
					void ctx.plugin.saveSettings();
					ctx.redisplay();
				}),
		);
	}
}

function renderFavoritesList(root: HTMLElement, ctx: SectionContext): void {
	const { settings } = ctx.plugin;

	const card = root.createDiv({ cls: 'vk-favorites-card' });
	const header = card.createDiv({ cls: 'vk-favorites-header' });
	header.createSpan({ cls: 'vk-favorites-title', text: '★ Favorites' });
	header.createSpan({
		cls: 'vk-favorites-count',
		text: settings.favoriteModels.length
			? `${settings.favoriteModels.length} pinned`
			: 'No favorites yet',
	});

	if (settings.favoriteModels.length === 0) {
		card.createDiv({
			cls: 'vk-favorites-empty',
			text: 'No chat models selected. Browse all models and tap ★ to add favorites — they become the short list you pick from in chats and settings.',
		});
	} else {
		const list = card.createDiv({ cls: 'vk-favorites-list' });
		settings.favoriteModels.forEach((fav, idx) => {
			renderFavoriteRow(list, fav, idx, settings.favoriteModels.length, ctx);
		});
	}

	const actions = card.createDiv({ cls: 'vk-favorites-actions' });
	const browseBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Browse all models…' });
	browseBtn.addEventListener('click', () => openBrowseAllPicker(ctx));
}

function renderFavoriteRow(
	parent: HTMLElement,
	fav: ModelRef,
	idx: number,
	total: number,
	ctx: SectionContext,
): void {
	const row = parent.createDiv({ cls: 'vk-favorite-row' });

	const info = row.createDiv({ cls: 'vk-favorite-info' });
	info.createDiv({ cls: 'vk-favorite-name', text: describeModelRef(ctx.plugin.settings, fav) });
	info.createDiv({ cls: 'vk-favorite-slug', text: fav.slug });

	const actions = row.createDiv({ cls: 'vk-favorite-actions' });

	const up = actions.createEl('button', {
		cls: 'vk-favorite-move',
		text: '↑',
		attr: { title: 'Move up', 'aria-label': 'Move up' },
	});
	if (idx === 0) up.setAttribute('disabled', 'true');
	up.addEventListener('click', () => {
		ctx.plugin.settings.favoriteModels = moveFavorite(ctx.plugin.settings.favoriteModels, fav, 'up');
		void ctx.plugin.saveSettings();
		ctx.redisplay();
	});

	const down = actions.createEl('button', {
		cls: 'vk-favorite-move',
		text: '↓',
		attr: { title: 'Move down', 'aria-label': 'Move down' },
	});
	if (idx === total - 1) down.setAttribute('disabled', 'true');
	down.addEventListener('click', () => {
		ctx.plugin.settings.favoriteModels = moveFavorite(ctx.plugin.settings.favoriteModels, fav, 'down');
		void ctx.plugin.saveSettings();
		ctx.redisplay();
	});

	const remove = actions.createEl('button', {
		cls: 'vk-favorite-remove',
		text: '×',
		attr: { title: 'Remove favorite', 'aria-label': 'Remove favorite' },
	});
	remove.addEventListener('click', () => {
		let next = { ...ctx.plugin.settings };
		next.favoriteModels = removeFavorite(next.favoriteModels, fav);
		next = rebindDefaultsToFavorites(next);
		ctx.plugin.settings = next;
		void ctx.plugin.saveSettings();
		ctx.redisplay();
	});
}

function openFavoritesPickerFor(
	ctx: SectionContext,
	current: ModelRef,
	onPick: (ref: ModelRef) => void,
): void {
	new FavoritesPickerModal(
		ctx.app,
		ctx.plugin.settings.endpoints,
		current,
		ctx.plugin.settings.favoriteModels,
		onPick,
		() => openBrowseAllPicker(ctx),
	).open();
}

function openBrowseAllPicker(ctx: SectionContext): void {
	new BrowseAllPickerModal(
		ctx.app,
		ctx.plugin.settings.endpoints,
		ctx.plugin.settings.defaultModelRef,
		ctx.plugin.settings.favoriteModels,
		{
			// Settings context: the whole picker IS the favorites editor, so
			// row clicks toggle favorite via onToggleFavorite (see mode below).
			// onPick is unreachable here but kept for the interface.
			onPick: () => undefined,
			onToggleFavorite: async (ref, nextFavorite) => {
				const current = ctx.plugin.settings;
				const updatedFavorites = nextFavorite
					? [...current.favoriteModels, ref]
					: removeFavorite(current.favoriteModels, ref);
				ctx.plugin.settings = rebindDefaultsToFavorites({
					...current,
					favoriteModels: updatedFavorites,
				});
				await ctx.plugin.saveSettings();
			},
			onClose: () => ctx.redisplay(),
			mode: 'manage',
		},
	).open();
}
