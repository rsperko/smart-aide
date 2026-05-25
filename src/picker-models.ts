import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import { friendlyModelName } from './models';
import {
	type BrowseItem,
	type FavoriteItem,
	buildBrowseAllPickerItems,
	buildFavoritesPickerItems,
} from './model-picker-filter';
import { sameRef } from './settings';
import { Endpoint, ModelRef } from './types';

// ============================================================================
// Favorites picker — the short-list flow.
// Used by: chat model chip, Settings → Default chat model, Settings → Title
// model. Shows only favorites. No stars (the browse picker is where you curate).
// Always carries a "Browse all models…" footer entry so the user can reach the
// other picker without leaving the flow.
// ============================================================================

interface FavoriteRow {
	kind: 'favorite';
	item: FavoriteItem;
	friendly: string;
}

interface BrowseAllRow {
	kind: 'browse-all';
	label: string;
}

type FavoriteEntry = FavoriteRow | BrowseAllRow;

export class FavoritesPickerModal extends FuzzySuggestModal<FavoriteEntry> {
	private readonly multiEndpoint: boolean;

	constructor(
		app: App,
		private endpoints: Endpoint[],
		private current: ModelRef,
		private favorites: ModelRef[],
		private onPick: (ref: ModelRef) => void,
		private onOpenBrowseAll: () => void,
	) {
		super(app);
		this.multiEndpoint = endpoints.length > 1;
		this.setPlaceholder(favorites.length ? 'Pick a model…' : 'No favorites yet — browse all to add some');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'select' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): FavoriteEntry[] {
		const items = buildFavoritesPickerItems(this.favorites, this.endpoints);
		const rows: FavoriteEntry[] = items.map((item) => ({
			kind: 'favorite' as const,
			item,
			friendly: friendlyModelName(item.ref.slug),
		}));
		rows.push({
			kind: 'browse-all',
			label: items.length === 0 ? 'Browse all models →' : 'Browse all models…',
		});
		return rows;
	}

	getItemText(entry: FavoriteEntry): string {
		if (entry.kind === 'browse-all') return entry.label;
		return `${entry.friendly} ${entry.item.ref.slug} ${entry.item.endpointName}`;
	}

	renderSuggestion(match: FuzzyMatch<FavoriteEntry>, el: HTMLElement): void {
		const entry = match.item;
		el.empty();

		if (entry.kind === 'browse-all') {
			el.addClass('vk-picker-row', 'vk-picker-browse-row');
			el.createSpan({ cls: 'vk-picker-browse-label', text: entry.label });
			return;
		}

		el.addClass('vk-picker-row', 'vk-picker-favorite-row');
		const { item, friendly } = entry;

		const main = el.createDiv({ cls: 'vk-picker-main' });
		main.createSpan({ cls: 'vk-picker-name', text: friendly });

		if (sameRef(item.ref, this.current)) {
			main.createSpan({ cls: 'vk-picker-tag vk-picker-tag-current', text: '· current' });
		}
		if (item.orphaned) {
			main.createSpan({ cls: 'vk-picker-tag vk-picker-tag-warn', text: '· endpoint removed' });
		} else if (item.stale) {
			main.createSpan({ cls: 'vk-picker-tag vk-picker-tag-warn', text: '· unavailable' });
		}

		const sub = el.createDiv({ cls: 'vk-picker-sub' });
		sub.setText(item.ref.slug);
		if (this.multiEndpoint || item.orphaned) {
			sub.createSpan({ cls: 'vk-picker-endpoint', text: `  [${item.endpointName}]` });
		}
	}

	onChooseItem(entry: FavoriteEntry): void {
		if (entry.kind === 'browse-all') {
			// Close happens automatically after onChooseItem returns. setTimeout
			// hands control back so the close completes before the next modal opens.
			window.setTimeout(() => this.onOpenBrowseAll(), 0);
			return;
		}
		if (entry.item.orphaned || entry.item.stale) {
			// Refuse to pick an unusable model — would result in a broken send.
			return;
		}
		this.onPick(entry.item.ref);
	}
}

// ============================================================================
// Browse-all picker — the discovery + curation flow.
// Used by: Settings → Browse all models, FavoritesPickerModal footer.
// Shows every discovered model across every endpoint. Star button toggles
// favorite state IN PLACE (no modal close/reopen) so mobile users see the
// state change immediately. Row click picks the model (and the caller can
// decide whether to auto-favorite as part of picking).
// ============================================================================

interface BrowseRow {
	item: BrowseItem;
	friendly: string;
}

export interface BrowseAllCallbacks {
	onPick: (ref: ModelRef) => void;
	onToggleFavorite: (ref: ModelRef, nextFavorite: boolean) => Promise<void> | void;
	/** Called once the modal closes (any reason: esc, click-outside, row pick).
	 * Lets the caller refresh state — e.g. re-render the settings tab so the
	 * favorites list reflects stars toggled while the modal was open. */
	onClose?: () => void;
}

export class BrowseAllPickerModal extends FuzzySuggestModal<BrowseRow> {
	private readonly multiEndpoint: boolean;
	private favoriteKeys: Set<string>;

	constructor(
		app: App,
		private endpoints: Endpoint[],
		private current: ModelRef,
		favorites: ModelRef[],
		private callbacks: BrowseAllCallbacks,
	) {
		super(app);
		this.multiEndpoint = endpoints.length > 1;
		this.favoriteKeys = new Set(favorites.map((f) => `${f.endpointId}::${f.slug}`));
		this.setPlaceholder('Browse all models — type to filter, ★ to favorite');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'pick' },
			{ command: '★', purpose: 'favorite' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): BrowseRow[] {
		// Pass the original favorite list reconstructed from our key set — we
		// only need it to mark isFavorite per row, and any updates we make in
		// renderSuggestion stay synced via favoriteKeys.
		const favorites: ModelRef[] = [];
		for (const key of this.favoriteKeys) {
			const [endpointId, slug] = key.split('::');
			favorites.push({ endpointId, slug });
		}
		const items = buildBrowseAllPickerItems(this.endpoints, favorites);
		return items.map((item) => ({ item, friendly: friendlyModelName(item.ref.slug) }));
	}

	getItemText(row: BrowseRow): string {
		return `${row.friendly} ${row.item.ref.slug} ${row.item.endpointName}`;
	}

	renderSuggestion(match: FuzzyMatch<BrowseRow>, el: HTMLElement): void {
		const { item, friendly } = match.item;
		el.empty();
		el.addClass('vk-picker-row', 'vk-picker-browse-model-row');

		const body = el.createDiv({ cls: 'vk-picker-body' });

		const main = body.createDiv({ cls: 'vk-picker-main' });
		main.createSpan({ cls: 'vk-picker-name', text: friendly });

		if (sameRef(item.ref, this.current)) {
			main.createSpan({ cls: 'vk-picker-tag vk-picker-tag-current', text: '· current' });
		}

		const meta = item.discovered;
		if (meta) {
			if (meta.contextLength !== undefined) {
				main.createSpan({ cls: 'vk-picker-meta', text: `· ${formatContext(meta.contextLength)}` });
			}
			if (meta.promptPrice !== undefined && meta.completionPrice !== undefined) {
				main.createSpan({
					cls: 'vk-picker-meta',
					text: `· ${formatPriceShort(meta.promptPrice, meta.completionPrice)}`,
				});
			}
			if (meta.supportsTools === false) {
				main.createSpan({ cls: 'vk-picker-meta vk-picker-meta-warn', text: '· no tools' });
			}
		}

		const sub = body.createDiv({ cls: 'vk-picker-sub' });
		sub.setText(item.ref.slug);
		if (this.multiEndpoint) {
			sub.createSpan({ cls: 'vk-picker-endpoint', text: `  [${item.endpointName}]` });
		}

		const key = `${item.ref.endpointId}::${item.ref.slug}`;
		const isFav = this.favoriteKeys.has(key);

		const star = el.createEl('button', {
			cls: isFav ? 'vk-picker-star vk-picker-star-on' : 'vk-picker-star',
			text: isFav ? '★' : '☆',
			attr: {
				'aria-label': isFav ? 'Unfavorite' : 'Favorite',
				title: isFav ? 'Unfavorite' : 'Add to favorites',
			},
		});

		// Stop row selection on every pointer event the modal listens to.
		// Update DOM in place — no close, no reopen — so the user sees state
		// flip immediately (the close/reopen pattern was eating the first tap
		// on mobile).
		const swallow = (ev: Event) => {
			ev.preventDefault();
			ev.stopPropagation();
		};
		star.addEventListener('mousedown', swallow);
		star.addEventListener('touchstart', swallow, { passive: false });
		star.addEventListener('click', async (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const wasFav = this.favoriteKeys.has(key);
			const nextFav = !wasFav;
			if (nextFav) this.favoriteKeys.add(key);
			else this.favoriteKeys.delete(key);
			star.setText(nextFav ? '★' : '☆');
			star.toggleClass('vk-picker-star-on', nextFav);
			star.setAttribute('aria-label', nextFav ? 'Unfavorite' : 'Favorite');
			star.setAttribute('title', nextFav ? 'Unfavorite' : 'Add to favorites');
			await this.callbacks.onToggleFavorite(item.ref, nextFav);
		});
	}

	onChooseItem(row: BrowseRow): void {
		this.callbacks.onPick(row.item.ref);
	}

	onClose(): void {
		super.onClose();
		this.callbacks.onClose?.();
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
