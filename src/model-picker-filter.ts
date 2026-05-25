import type { DiscoveredModel, Endpoint, ModelRef } from './types';

export interface FavoriteItem {
	ref: ModelRef;
	endpointName: string;
	discovered?: DiscoveredModel;
	/** True when the favorite's endpoint exists but the slug isn't in
	 * discoveredModels (or endpoint.models). The row still renders so the user
	 * can unstar it. */
	stale: boolean;
	/** True when the entire endpoint was deleted. endpointName falls back to
	 * the endpointId in this case. */
	orphaned: boolean;
}

export interface BrowseItem {
	ref: ModelRef;
	endpointName: string;
	discovered?: DiscoveredModel;
	isFavorite: boolean;
}

function keyOf(ref: ModelRef): string {
	return `${ref.endpointId}::${ref.slug}`;
}

/**
 * Items for the Favorites picker (chat model chip, default/title pickers in
 * Settings). Returns favorites in their stored order, annotated with whether
 * the underlying endpoint/slug still exists. Stale/orphan rows still render so
 * the user has a recovery path — unstar from the browse picker.
 */
export function buildFavoritesPickerItems(
	favorites: ModelRef[],
	endpoints: Endpoint[],
): FavoriteItem[] {
	const items: FavoriteItem[] = [];
	for (const ref of favorites) {
		const endpoint = endpoints.find((e) => e.id === ref.endpointId);
		if (!endpoint) {
			items.push({
				ref,
				endpointName: ref.endpointId,
				discovered: undefined,
				stale: true,
				orphaned: true,
			});
			continue;
		}
		const discovered = endpoint.discoveredModels?.find((m) => m.id === ref.slug);
		const inManual = (endpoint.models ?? []).includes(ref.slug);
		items.push({
			ref,
			endpointName: endpoint.name,
			discovered,
			stale: !discovered && !inManual,
			orphaned: false,
		});
	}
	return items;
}

/**
 * Items for the Browse-all picker. Flattens every discovered (or manually
 * listed) model across every endpoint. Each item is marked with isFavorite so
 * the star button reflects current state. No "curated subset" concept —
 * favorites is the only curation surface.
 */
export function buildBrowseAllPickerItems(
	endpoints: Endpoint[],
	favorites: ModelRef[],
): BrowseItem[] {
	const favoriteKeys = new Set(favorites.map(keyOf));
	const items: BrowseItem[] = [];
	const seen = new Set<string>();

	for (const endpoint of endpoints) {
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
				discovered: discoveredById.get(slug),
				isFavorite: favoriteKeys.has(key),
			});
		}
	}

	items.sort((a, b) => {
		// Favorites first (so they're easy to find while browsing), then
		// alphabetical by slug.
		if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
		return a.ref.slug.localeCompare(b.ref.slug);
	});

	return items;
}
