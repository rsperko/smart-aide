import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import { friendlyModelName } from './models';
import { type PickerItem, buildModelPickerItems } from './model-picker-filter';
import { sameRef } from './settings';
import { Endpoint, ModelRef } from './types';

interface DisplayItem {
	item: PickerItem;
	friendly: string;
}

export interface ModelPickerCallbacks {
	onPick: (ref: ModelRef) => void;
	/** Called when the user taps the star button on a row. The caller persists
	 * the new favorites list and re-opens the picker (handled internally so the
	 * UI stays in sync without a parent re-render dance). */
	onToggleFavorite?: (ref: ModelRef) => Promise<void> | void;
}

export class ModelPickerModal extends FuzzySuggestModal<DisplayItem> {
	private readonly multiEndpoint: boolean;

	constructor(
		app: App,
		private endpoints: Endpoint[],
		private current: ModelRef,
		private recents: ModelRef[],
		private favorites: ModelRef[],
		private callbacks: ModelPickerCallbacks,
		private showAll: boolean = false,
	) {
		super(app);
		this.multiEndpoint = endpoints.length > 1;
		this.setPlaceholder(showAll ? 'Select a model (all discovered)…' : 'Select a model…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'select' },
			{ command: '★', purpose: 'favorite' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): DisplayItem[] {
		const { items } = buildModelPickerItems({
			endpoints: this.endpoints,
			current: this.current,
			recents: this.recents,
			favorites: this.favorites,
			showAll: this.showAll,
		});
		return items.map((item) =>
			item.kind === 'model'
				? { item, friendly: friendlyModelName(item.slug) }
				: { item, friendly: item.label },
		);
	}

	getItemText(d: DisplayItem): string {
		if (d.item.kind === 'toggle') return d.item.label;
		return `${d.friendly} ${d.item.ref.slug} ${d.item.endpointName}`;
	}

	renderSuggestion(match: FuzzyMatch<DisplayItem>, el: HTMLElement): void {
		const { item, friendly } = match.item;
		el.empty();
		el.addClass('vk-model-suggestion');

		if (item.kind === 'toggle') {
			el.addClass('vk-model-suggestion-toggle');
			el.createDiv({ cls: 'vk-model-suggestion-name', text: item.label });
			return;
		}

		const body = el.createDiv({ cls: 'vk-model-suggestion-body' });

		const main = body.createDiv({ cls: 'vk-model-suggestion-main' });
		main.createSpan({ cls: 'vk-model-suggestion-name', text: friendly });

		if (sameRef(item.ref, this.current)) {
			main.createSpan({ cls: 'vk-model-suggestion-current', text: '· current' });
		} else if (this.isRecent(item.ref)) {
			main.createSpan({ cls: 'vk-model-suggestion-recent', text: '· recent' });
		}

		const meta = item.discovered;
		if (meta) {
			if (meta.contextLength !== undefined) {
				main.createSpan({ cls: 'vk-model-suggestion-meta', text: `· ${formatContext(meta.contextLength)}` });
			}
			if (meta.promptPrice !== undefined && meta.completionPrice !== undefined) {
				main.createSpan({
					cls: 'vk-model-suggestion-meta',
					text: `· ${formatPriceShort(meta.promptPrice, meta.completionPrice)}`,
				});
			}
			if (meta.supportsTools === false) {
				main.createSpan({ cls: 'vk-model-suggestion-tools', text: '· no tools' });
			}
		}

		const sub = body.createDiv({ cls: 'vk-model-suggestion-slug' });
		sub.setText(item.ref.slug);
		if (this.multiEndpoint) {
			sub.createSpan({ cls: 'vk-model-suggestion-endpoint', text: `  [${item.endpointName}]` });
		}

		if (this.callbacks.onToggleFavorite) {
			const star = el.createEl('button', {
				cls: item.isFavorite ? 'vk-model-suggestion-star vk-model-suggestion-star-on' : 'vk-model-suggestion-star',
				text: item.isFavorite ? '★' : '☆',
				attr: {
					'aria-label': item.isFavorite ? 'Unfavorite' : 'Favorite',
					title: item.isFavorite ? 'Unfavorite' : 'Add to favorites',
				},
			});
			// FuzzySuggestModal binds row selection on click; stop here so the star
			// only toggles the favorite. mousedown/touchstart cover the cases where
			// FuzzySuggestModal commits on mousedown (it does on some platforms).
			const stop = (ev: Event) => {
				ev.preventDefault();
				ev.stopPropagation();
			};
			star.addEventListener('mousedown', stop);
			star.addEventListener('touchstart', stop, { passive: false });
			star.addEventListener('click', async (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				await this.toggleFavorite(item.ref);
			});
		}
	}

	onChooseItem(d: DisplayItem): void {
		const { item } = d;
		if (item.kind === 'toggle') {
			const nextShowAll = item.mode === 'expand';
			// Re-open the picker with the new mode. setTimeout 0 lets the current
			// modal finish closing before we open the next one (Obsidian quirks).
			window.setTimeout(() => {
				new ModelPickerModal(
					this.app,
					this.endpoints,
					this.current,
					this.recents,
					this.favorites,
					this.callbacks,
					nextShowAll,
				).open();
			}, 0);
			return;
		}
		this.callbacks.onPick(item.ref);
	}

	private async toggleFavorite(ref: ModelRef): Promise<void> {
		if (!this.callbacks.onToggleFavorite) return;
		const wasFavorite = this.favorites.some((f) => sameRef(f, ref));
		this.favorites = wasFavorite
			? this.favorites.filter((f) => !sameRef(f, ref))
			: [...this.favorites, ref];
		await this.callbacks.onToggleFavorite(ref);
		// Re-open so the row order and star state both refresh — the modal's
		// internal item list is cached after first render otherwise.
		this.close();
		const showAll = this.showAll;
		window.setTimeout(() => {
			new ModelPickerModal(
				this.app,
				this.endpoints,
				this.current,
				this.recents,
				this.favorites,
				this.callbacks,
				showAll,
			).open();
		}, 0);
	}

	private isRecent(ref: ModelRef): boolean {
		return this.recents.some((r) => sameRef(r, ref));
	}
}

function formatContext(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return `${tokens}`;
}

function formatPriceShort(promptPerM: number, completionPerM: number): string {
	const p = formatDollar(promptPerM);
	const c = formatDollar(completionPerM);
	return p === c ? `$${p}/M` : `$${p}/$${c}·M`;
}

function formatDollar(n: number): string {
	if (n === 0) return '0';
	if (n < 1) return n.toFixed(2);
	if (n < 10) return n.toFixed(1);
	return Math.round(n).toString();
}
