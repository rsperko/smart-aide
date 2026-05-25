import type { DiscoveredModel, Endpoint, ModelRef } from './types';

export interface ModelItem {
	kind: 'model';
	ref: ModelRef;
	endpointName: string;
	slug: string;
	discovered?: DiscoveredModel;
	/** True for items in the manual endpoint.models curation, OR for items
	 * from an endpoint that has no curation at all (otherwise it would have
	 * an empty picker). */
	isCurated: boolean;
	/** True when this ref appears in settings.favoriteModels. Drives the filled
	 * star in the picker and bubbles the row to the top of the list. */
	isFavorite: boolean;
}

export interface ToggleItem {
	kind: 'toggle';
	mode: 'expand' | 'collapse';
	label: string;
}

export type PickerItem = ModelItem | ToggleItem;

export interface BuildItemsInput {
	endpoints: Endpoint[];
	current: ModelRef;
	recents: ModelRef[];
	favorites: ModelRef[];
	showAll: boolean;
}

export interface BuildItemsResult {
	items: PickerItem[];
	hiddenCount: number;
}

function keyOf(ref: ModelRef): string {
	return `${ref.endpointId}::${ref.slug}`;
}

/**
 * Pure logic behind ModelPickerModal.getItems — extracted so it can be unit-tested
 * without spinning up Obsidian. Default mode (showAll=false) returns only models
 * listed in endpoint.models, plus any favorite/current/recent models so the user
 * can never lose sight of pinned context. Endpoints with empty curation lists
 * fall back to showing all of their discovered models so they don't appear empty.
 *
 * Favorites are *also* surfaced when their endpoint is missing or doesn't list
 * them in discovered/manual — a stale favorite still renders so the user can
 * unstar it (the row just has no `discovered` metadata).
 */
export function buildModelPickerItems(input: BuildItemsInput): BuildItemsResult {
	const { endpoints, current, recents, favorites, showAll } = input;

	const favoriteKeys = new Set(favorites.map(keyOf));
	const recentKeys = recents.map(keyOf);
	const favoriteOrder = new Map(favorites.map((f, i) => [keyOf(f), i]));

	const alwaysVisibleKeys = new Set<string>();
	for (const r of [current, ...recents, ...favorites]) alwaysVisibleKeys.add(keyOf(r));

	const items: ModelItem[] = [];
	const seen = new Set<string>();
	let hiddenCount = 0;

	for (const endpoint of endpoints) {
		const discoveredById = new Map((endpoint.discoveredModels ?? []).map((m) => [m.id, m]));
		const manualSlugs = endpoint.models ?? [];
		const curatedKeys = new Set(manualSlugs.map((s) => `${endpoint.id}::${s}`));
		const endpointHasCurated = manualSlugs.length > 0;

		const slugs = new Set<string>([
			...manualSlugs,
			...(endpoint.discoveredModels ?? []).map((m) => m.id),
		]);

		for (const slug of slugs) {
			const key = `${endpoint.id}::${slug}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const isCurated = curatedKeys.has(key);
			const isFavorite = favoriteKeys.has(key);
			const isAlwaysVisible = alwaysVisibleKeys.has(key);
			const include = showAll || isCurated || isAlwaysVisible || !endpointHasCurated;
			if (!include) {
				hiddenCount++;
				continue;
			}

			items.push({
				kind: 'model',
				ref: { endpointId: endpoint.id, slug },
				endpointName: endpoint.name,
				slug,
				discovered: discoveredById.get(slug),
				isCurated: isCurated || !endpointHasCurated,
				isFavorite,
			});
		}
	}

	// Stale favorites: refs to slugs (or endpoints) the picker hasn't surfaced
	// yet. Still render them so the user can unstar — otherwise a removed
	// endpoint orphans favorites with no UI escape hatch.
	for (const fav of favorites) {
		const key = keyOf(fav);
		if (seen.has(key)) continue;
		seen.add(key);
		const endpoint = endpoints.find((e) => e.id === fav.endpointId);
		items.push({
			kind: 'model',
			ref: fav,
			endpointName: endpoint?.name ?? fav.endpointId,
			slug: fav.slug,
			discovered: undefined,
			isCurated: false,
			isFavorite: true,
		});
	}

	const rankRecent = (item: ModelItem) => {
		const idx = recentKeys.indexOf(keyOf(item.ref));
		return idx < 0 ? Infinity : idx;
	};
	const rankFavorite = (item: ModelItem) => {
		const idx = favoriteOrder.get(keyOf(item.ref));
		return idx === undefined ? Infinity : idx;
	};

	items.sort((a, b) => {
		const fa = rankFavorite(a);
		const fb = rankFavorite(b);
		if (fa !== fb) return fa - fb;
		const ra = rankRecent(a);
		const rb = rankRecent(b);
		if (ra !== rb) return ra - rb;
		const ca = a.isCurated ? 0 : 1;
		const cb = b.isCurated ? 0 : 1;
		if (ca !== cb) return ca - cb;
		return a.slug.localeCompare(b.slug);
	});

	const out: PickerItem[] = [...items];
	if (showAll) {
		out.push({ kind: 'toggle', mode: 'collapse', label: 'Show curated only ↑' });
	} else if (hiddenCount > 0) {
		out.push({
			kind: 'toggle',
			mode: 'expand',
			label: `Show all ${hiddenCount} discovered model${hiddenCount === 1 ? '' : 's'} ↓`,
		});
	}

	return { items: out, hiddenCount };
}
