import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import { friendlyModelName } from './models';
import { type PickerItem, buildModelPickerItems } from './model-picker-filter';
import { sameRef } from './settings';
import { Endpoint, ModelRef } from './types';

interface DisplayItem {
	item: PickerItem;
	friendly: string;
}

export class ModelPickerModal extends FuzzySuggestModal<DisplayItem> {
	private readonly multiEndpoint: boolean;

	constructor(
		app: App,
		private endpoints: Endpoint[],
		private current: ModelRef,
		private recents: ModelRef[],
		private onPick: (ref: ModelRef) => void,
		private showAll: boolean = false,
	) {
		super(app);
		this.multiEndpoint = endpoints.length > 1;
		this.setPlaceholder(showAll ? 'Select a model (all discovered)…' : 'Select a model…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'select' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): DisplayItem[] {
		const { items } = buildModelPickerItems({
			endpoints: this.endpoints,
			current: this.current,
			recents: this.recents,
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

		const main = el.createDiv({ cls: 'vk-model-suggestion-main' });
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
			if (meta.supportsTools === true) {
				main.createSpan({ cls: 'vk-model-suggestion-tools', text: '· 🔧' });
			} else if (meta.supportsTools === false) {
				main.createSpan({ cls: 'vk-model-suggestion-tools', text: '· no tools' });
			}
		}

		const sub = el.createDiv({ cls: 'vk-model-suggestion-slug' });
		sub.setText(item.ref.slug);
		if (this.multiEndpoint) {
			sub.createSpan({ cls: 'vk-model-suggestion-endpoint', text: `  [${item.endpointName}]` });
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
					this.onPick,
					nextShowAll,
				).open();
			}, 0);
			return;
		}
		this.onPick(item.ref);
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
