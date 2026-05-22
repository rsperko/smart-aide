import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import { friendlyModelName } from './models';
import { DiscoveredModel, Endpoint, ModelRef } from './types';

interface PickerItem {
	ref: ModelRef;
	endpointName: string;
	friendly: string;
	discovered?: DiscoveredModel;
}

export class ModelPickerModal extends FuzzySuggestModal<PickerItem> {
	private readonly multiEndpoint: boolean;

	constructor(
		app: App,
		private endpoints: Endpoint[],
		private current: ModelRef,
		private recents: ModelRef[],
		private onPick: (ref: ModelRef) => void,
	) {
		super(app);
		this.multiEndpoint = endpoints.length > 1;
		this.setPlaceholder('Select a model…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'select' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): PickerItem[] {
		const items: PickerItem[] = [];
		const seen = new Set<string>();

		for (const endpoint of this.endpoints) {
			const discoveredById = new Map((endpoint.discoveredModels ?? []).map((m) => [m.id, m]));
			const slugs = new Set<string>([
				...(endpoint.models ?? []),
				...(endpoint.discoveredModels ?? []).map((m) => m.id),
			]);
			for (const slug of slugs) {
				const key = `${endpoint.id}::${slug}`;
				if (seen.has(key)) continue;
				seen.add(key);
				items.push({
					ref: { endpointId: endpoint.id, slug },
					endpointName: endpoint.name,
					friendly: friendlyModelName(slug),
					discovered: discoveredById.get(slug),
				});
			}
		}

		const recentKeys = this.recents.map((r) => `${r.endpointId}::${r.slug}`);
		const rankRecent = (item: PickerItem) => {
			const idx = recentKeys.indexOf(`${item.ref.endpointId}::${item.ref.slug}`);
			return idx < 0 ? Infinity : idx;
		};

		items.sort((a, b) => {
			const ra = rankRecent(a);
			const rb = rankRecent(b);
			if (ra !== rb) return ra - rb;
			return a.friendly.localeCompare(b.friendly);
		});

		return items;
	}

	getItemText(item: PickerItem): string {
		return `${item.friendly} ${item.ref.slug} ${item.endpointName}`;
	}

	renderSuggestion(match: FuzzyMatch<PickerItem>, el: HTMLElement): void {
		const item = match.item;
		el.empty();
		el.addClass('vk-model-suggestion');

		const main = el.createDiv({ cls: 'vk-model-suggestion-main' });
		main.createSpan({ cls: 'vk-model-suggestion-name', text: item.friendly });

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

	onChooseItem(item: PickerItem): void {
		this.onPick(item.ref);
	}

	private isRecent(ref: ModelRef): boolean {
		return this.recents.some((r) => sameRef(r, ref));
	}
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
	return a.endpointId === b.endpointId && a.slug === b.slug;
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
