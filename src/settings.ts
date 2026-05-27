import { DEFAULT_MODEL, friendlyModelName } from './models';
import { DiscoveredModel, Endpoint, ModelRef } from './types';
import type { ApiKeyStore } from './api-key-store';
import type { DeviceSettings, DeviceSettingsStore } from './device-settings-store';

export interface SmartAideSettings {
	endpoints: Endpoint[];
	defaultModelRef: ModelRef;
	titleModelRef: ModelRef;
	/** Cross-endpoint favorites — ordered. Every model picker shows favorites
	 * first; defaults are picked from this list. The Settings tab renders the
	 * list inline so users can curate across providers. */
	favoriteModels: ModelRef[];
	systemPrompt: string;
	autoApproveWrites: boolean;
	metaDir: string;
	/** One-time UI flag: has the user seen the "@ now pins notes as context" tip? */
	hasSeenMentionTip: boolean;
	/** Apply cache_control to system + tools when calling Anthropic-native endpoints. */
	anthropicPromptCaching: boolean;
	/** Block send when the next-turn projected cost exceeds this USD value. 0 = off. */
	costCapPerTurnUsd: number;
}

export const DEFAULT_META_DIR = 'Meta';

// Smart Aide-only persistent state nests inside a branded subfolder. Cross-tool
// standards (skills/, AGENTS.md) stay at `${metaDir}` so they read as
// vault-native and can symlink to ~/.agents/* for Pi / Claude Code. Anything
// the plugin owns end-to-end (chats, internals, model-curated memory) lives
// under `${metaDir}/Smart Aide/` so the file tree visibly says "this is the
// plugin's storage, not your notes."
export const PLUGIN_HOME_SUBFOLDER = 'Smart Aide';
export const pluginHomeFor = (metaDir: string): string => `${metaDir}/${PLUGIN_HOME_SUBFOLDER}`;
export const chatsDirFor = (metaDir: string): string => `${pluginHomeFor(metaDir)}/chats`;
export const skillsDirFor = (metaDir: string): string => `${metaDir}/skills`;
export const internalDirFor = (metaDir: string): string => `${pluginHomeFor(metaDir)}/.internals`;
export const memoryFileFor = (metaDir: string): string => `${pluginHomeFor(metaDir)}/memory.md`;

/**
 * Strip leading/trailing slashes and collapse repeats. `pathGuard` also
 * normalizes its input as a safety net; this keeps the persisted setting clean
 * so derived paths (chats/skills/internal) don't carry stray separators.
 */
export function normalizeMetaDir(raw: string): string {
	const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
	return trimmed || DEFAULT_META_DIR;
}

export const OPENROUTER_ID = 'openrouter';

export const DEFAULT_SYSTEM_PROMPT = [
	"You help the user explore their Obsidian vault. They read on a phone half the time — keep responses tight.",
	'',
	"Silent between tool calls; speak only at turn end.",
	'',
	'Response shape by intent:',
	'',
	'| Intent | Response |',
	'|---|---|',
	'| Find / "where is X" | ≤2 sentences naming the note. Citation card auto-renders — don\'t quote. |',
	'| What\'s in / summarize | Tight blockquote (`> …`) of the relevant section + one-line frame. Blockquote, NOT raw headings/lists. |',
	'| Compare / connect | Prose with `[[Path/Note#Heading]]` wikilinks. |',
	'| Write / edit / delete | Tool call. write_note carries FULL final content. One change per call. Only when asked. |',
	'',
	"Never repeat the user's question or paraphrase content a citation card / blockquote already shows.",
	'',
	'Obsidian markdown (use everywhere — chat replies AND write_note content):',
	'- Links: `[[Note]]`, `[[Path/Note#Heading]]`, `[[Note|alias]]`. NEVER `[md](links.md)`.',
	'- Embed: `![[Note#Section]]`. Only when user asks.',
	'- Tags: inline `#kebab-tag`; frontmatter `tags: [a, b]`.',
	'- Callouts: `> [!note]` / `> [!tip]` / `> [!warning]`. First line `> [!type] Title`, body `> …`. NOT `> **Note:**`.',
	'- Highlight `==text==`, tasks `- [ ]` / `- [x]`.',
	'- Always include the heading anchor in wikilinks when known — use exact heading text from search/read results.',
	'- write_note: never start body with `# <Filename>` (Obsidian renders filename as title — would duplicate). Use `## ` for sections.',
].join('\n');

export function defaultOpenRouterEndpoint(apiKey = '', models?: string[]): Endpoint {
	// No pre-seeded model list — /models discovery is authoritative once a key
	// is set. An explicit models arg is honored (used by the legacy migration
	// path to preserve a user-curated list from a previous install).
	const endpoint: Endpoint = {
		id: OPENROUTER_ID,
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		apiKey,
	};
	if (models && models.length > 0) endpoint.models = models;
	return endpoint;
}

export const DEFAULT_SETTINGS: SmartAideSettings = {
	endpoints: [defaultOpenRouterEndpoint()],
	defaultModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
	titleModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
	favoriteModels: [],
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	autoApproveWrites: false,
	metaDir: DEFAULT_META_DIR,
	hasSeenMentionTip: false,
	anthropicPromptCaching: true,
	costCapPerTurnUsd: 0,
};

/**
 * Build the in-memory `SmartAideSettings` from whatever shape `data.json`
 * carries. data.json now only holds vault-scoped fields (metaDir,
 * systemPrompt, hasSeenMentionTip); per-device fields come from the device
 * store and keys come from the api-key store. Unknown / missing values fall
 * through to defaults.
 */
export function parseRawSettings(raw: Record<string, unknown> | null | undefined): SmartAideSettings {
	const r = (raw ?? {}) as Record<string, unknown>;
	return {
		endpoints: Array.isArray(r.endpoints) ? (r.endpoints as Endpoint[]) : [],
		defaultModelRef: (r.defaultModelRef as ModelRef) ?? DEFAULT_SETTINGS.defaultModelRef,
		titleModelRef:
			(r.titleModelRef as ModelRef) ??
			(r.defaultModelRef as ModelRef) ??
			DEFAULT_SETTINGS.titleModelRef,
		favoriteModels: sanitizeFavorites(r.favoriteModels),
		systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : DEFAULT_SYSTEM_PROMPT,
		autoApproveWrites: typeof r.autoApproveWrites === 'boolean' ? r.autoApproveWrites : false,
		metaDir: typeof r.metaDir === 'string' ? normalizeMetaDir(r.metaDir) : DEFAULT_META_DIR,
		hasSeenMentionTip: typeof r.hasSeenMentionTip === 'boolean' ? r.hasSeenMentionTip : false,
		anthropicPromptCaching:
			typeof r.anthropicPromptCaching === 'boolean' ? r.anthropicPromptCaching : true,
		costCapPerTurnUsd: sanitizeCap(r.costCapPerTurnUsd),
	};
}

function sanitizeCap(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
	if (!Number.isFinite(n) || n < 0) return 0;
	return n;
}

function sanitizeFavorites(raw: unknown): ModelRef[] {
	if (!Array.isArray(raw)) return [];
	const out: ModelRef[] = [];
	const seen = new Set<string>();
	for (const v of raw) {
		if (!v || typeof v !== 'object') continue;
		const ref = v as Partial<ModelRef>;
		if (typeof ref.endpointId !== 'string' || typeof ref.slug !== 'string') continue;
		const key = `${ref.endpointId}::${ref.slug}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ endpointId: ref.endpointId, slug: ref.slug });
	}
	return out;
}

/**
 * Populate `endpoint.apiKey` from the per-device key store. Missing entries
 * resolve to an empty string — the empty-state UI prompts the user to add a
 * key. Keys never come from data.json: they live only in the local store.
 */
export function hydrateApiKeysFromStore(
	settings: SmartAideSettings,
	store: ApiKeyStore,
): SmartAideSettings {
	return {
		...settings,
		endpoints: settings.endpoints.map((e) => ({ ...e, apiKey: store.get(e.id) })),
	};
}

/** Mirror every endpoint's current `apiKey` into the per-device key store. */
export function captureApiKeysToStore(settings: SmartAideSettings, store: ApiKeyStore): void {
	for (const e of settings.endpoints) {
		store.set(e.id, e.apiKey ?? '');
	}
}

/** Deep-copy of settings with `apiKey` blanked on every endpoint. Use this as
 * the payload for `saveData` so the synced `data.json` never carries secrets. */
export function stripApiKeysForPersistence(settings: SmartAideSettings): SmartAideSettings {
	return {
		...settings,
		endpoints: settings.endpoints.map((e) => ({ ...e, apiKey: '' })),
	};
}

/**
 * Replace per-device fields in `settings` with whatever's in the device store.
 * Missing fields fall back to defaults — never to data.json, since data.json
 * no longer carries these values. A fresh device sees an empty providers list
 * and the empty-state UI prompts the user to add one.
 */
export function hydrateDeviceSettingsFromStore(
	settings: SmartAideSettings,
	store: DeviceSettingsStore,
): SmartAideSettings {
	const stored = store.get();
	if (!stored) {
		return {
			...settings,
			endpoints: [],
			favoriteModels: [],
			defaultModelRef: { ...DEFAULT_SETTINGS.defaultModelRef },
			titleModelRef: { ...DEFAULT_SETTINGS.titleModelRef },
			autoApproveWrites: false,
			costCapPerTurnUsd: 0,
			anthropicPromptCaching: true,
		};
	}
	return {
		...settings,
		endpoints: Array.isArray(stored.endpoints) ? stored.endpoints : [],
		favoriteModels: sanitizeFavorites(stored.favoriteModels),
		defaultModelRef: stored.defaultModelRef ?? DEFAULT_SETTINGS.defaultModelRef,
		titleModelRef: stored.titleModelRef ?? DEFAULT_SETTINGS.titleModelRef,
		autoApproveWrites:
			typeof stored.autoApproveWrites === 'boolean' ? stored.autoApproveWrites : false,
		costCapPerTurnUsd: sanitizeCap(stored.costCapPerTurnUsd),
		anthropicPromptCaching:
			typeof stored.anthropicPromptCaching === 'boolean' ? stored.anthropicPromptCaching : true,
	};
}

/**
 * Write the current per-device field values into the store. Called on every
 * save so the device store stays in sync with the in-memory `settings`. The
 * stored endpoints have `apiKey` blanked — keys live in the separate
 * api-key-store.
 */
export function captureDeviceSettingsToStore(
	settings: SmartAideSettings,
	store: DeviceSettingsStore,
): void {
	const snapshot: DeviceSettings = {
		endpoints: settings.endpoints.map((e) => ({ ...e, apiKey: '' })),
		favoriteModels: [...settings.favoriteModels],
		defaultModelRef: { ...settings.defaultModelRef },
		titleModelRef: { ...settings.titleModelRef },
		autoApproveWrites: settings.autoApproveWrites,
		costCapPerTurnUsd: settings.costCapPerTurnUsd,
		anthropicPromptCaching: settings.anthropicPromptCaching,
	};
	store.set(snapshot);
}

/**
 * Strip per-device fields from settings before writing to data.json. Endpoints
 * become an empty array (Array.isArray stays true, so migrateSettings on a
 * fresh peer device respects "no providers set up yet" rather than resurrecting
 * the legacy OpenRouter scaffold). Defaults reset to the same sentinel a fresh
 * install would carry; favorites empty; safety toggles to off / defaults.
 */
export function stripDeviceSettingsForPersistence(settings: SmartAideSettings): SmartAideSettings {
	return {
		...settings,
		endpoints: [],
		favoriteModels: [],
		defaultModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
		titleModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
		autoApproveWrites: false,
		costCapPerTurnUsd: 0,
		anthropicPromptCaching: true,
	};
}

export function findEndpoint(settings: SmartAideSettings, id: string): Endpoint | undefined {
	return settings.endpoints.find((e) => e.id === id);
}

export function resolveModelRef(
	settings: SmartAideSettings,
	ref: ModelRef,
): { endpoint: Endpoint; slug: string } {
	const endpoint = findEndpoint(settings, ref.endpointId) ?? settings.endpoints[0];
	return { endpoint, slug: ref.slug };
}

/**
 * Like resolveModelRef, but returns null when the referenced endpoint no longer
 * exists. Use on the send path to refuse a request rather than silently pairing
 * a stale slug with whichever endpoint happens to be first.
 */
export function resolveModelRefStrict(
	settings: SmartAideSettings,
	ref: ModelRef,
): { endpoint: Endpoint; slug: string } | null {
	const endpoint = findEndpoint(settings, ref.endpointId);
	if (!endpoint) return null;
	return { endpoint, slug: ref.slug };
}

export function endpointModelCount(endpoint: Endpoint): number {
	const discovered = endpoint.discoveredModels ?? [];
	const manual = endpoint.models ?? [];
	const merged = new Set([...manual, ...discovered.map((m) => m.id)]);
	return merged.size;
}

export function isEndpointConnected(endpoint: Endpoint): boolean {
	return Boolean(endpoint.apiKey) && endpointModelCount(endpoint) > 0;
}

export function endpointSummary(endpoint: Endpoint): string {
	if (!endpoint.apiKey) return 'no key';
	const count = endpointModelCount(endpoint);
	const parts: string[] = [`${count} ${count === 1 ? 'model' : 'models'}`];

	if (endpoint.lastTest) {
		if (endpoint.lastTest.ok) {
			parts.push(`✓ tested ${describeFreshness(endpoint.lastTest.at)}`);
		} else {
			const msg = endpoint.lastTest.message ?? 'test failed';
			parts.push(`✗ ${msg} · ${describeFreshness(endpoint.lastTest.at)}`);
		}
	} else if (endpoint.discoveredAt) {
		parts.push(`refreshed ${describeFreshness(endpoint.discoveredAt)}`);
	} else {
		parts.push('not refreshed');
	}

	return parts.join(' · ');
}

export function describeFreshness(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return iso.slice(0, 10);
	const minutes = Math.floor((Date.now() - then) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 30) return `${days}d ago`;
	return iso.slice(0, 10);
}

export function sameRef(a: ModelRef, b: ModelRef): boolean {
	return a.endpointId === b.endpointId && a.slug === b.slug;
}

export function newEndpointId(existing: Endpoint[]): string {
	let i = 1;
	while (existing.some((e) => e.id === `endpoint-${i}`)) i++;
	return `endpoint-${i}`;
}

export function pickReplacementModelRef(settings: SmartAideSettings): ModelRef {
	const fallback = settings.endpoints[0];
	const slug = fallback?.models?.[0] ?? fallback?.discoveredModels?.[0]?.id ?? DEFAULT_MODEL;
	return { endpointId: fallback?.id ?? OPENROUTER_ID, slug };
}

export function describeModelRef(settings: SmartAideSettings, ref: ModelRef): string {
	const endpoint = findEndpoint(settings, ref.endpointId);
	const friendly = friendlyModelName(ref.slug);
	if (settings.endpoints.length <= 1) return friendly;
	return `${friendly} · ${endpoint?.name ?? ref.endpointId}`;
}

export function isFavoriteRef(favorites: ModelRef[], ref: ModelRef): boolean {
	return favorites.some((f) => sameRef(f, ref));
}

export function toggleFavorite(favorites: ModelRef[], ref: ModelRef): ModelRef[] {
	if (isFavoriteRef(favorites, ref)) return favorites.filter((f) => !sameRef(f, ref));
	return [...favorites, ref];
}

export function removeFavorite(favorites: ModelRef[], ref: ModelRef): ModelRef[] {
	return favorites.filter((f) => !sameRef(f, ref));
}

/** Move a favorite up or down in the ordered list. No-ops if the move would go
 * out of bounds, so callers can wire arrow buttons without bounds-checking. */
export function moveFavorite(favorites: ModelRef[], ref: ModelRef, direction: 'up' | 'down'): ModelRef[] {
	const i = favorites.findIndex((f) => sameRef(f, ref));
	if (i < 0) return favorites;
	const j = direction === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= favorites.length) return favorites;
	const next = [...favorites];
	const tmp = next[i];
	next[i] = next[j];
	next[j] = tmp;
	return next;
}

/** "Did /models give us anything?" Drives the conditional manual-list reveal in
 * the endpoint editor — when discovery works, manual is fallback (in Advanced);
 * when it doesn't, manual is the primary path. */
export function hasWorkingDiscovery(endpoint: Endpoint): boolean {
	return (endpoint.discoveredModels?.length ?? 0) > 0;
}

/** Keep defaults aligned with favorites. If the current default or title ref
 * is no longer in favorites (e.g. the user just unstarred it), bind to the
 * first remaining favorite. If favorites is empty, leave the refs alone so
 * the picker can show its empty state and the user can recover. */
export function rebindDefaultsToFavorites(settings: SmartAideSettings): SmartAideSettings {
	const { favoriteModels, defaultModelRef, titleModelRef } = settings;
	if (favoriteModels.length === 0) return settings;
	const next = { ...settings };
	if (!isFavoriteRef(favoriteModels, defaultModelRef)) {
		next.defaultModelRef = { ...favoriteModels[0] };
	}
	if (!isFavoriteRef(favoriteModels, titleModelRef)) {
		// Re-mirror to the (possibly new) default rather than picking a
		// different favorite — title-following-default is the dominant case.
		next.titleModelRef = { ...next.defaultModelRef };
	}
	return next;
}

export function previewSystemPrompt(prompt: string): string {
	const flat = prompt.replace(/\s+/g, ' ').trim();
	return flat.length > 120 ? flat.slice(0, 117) + '…' : flat;
}

export type { DiscoveredModel };
