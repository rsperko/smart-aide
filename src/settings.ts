import { DEFAULT_MODEL, DEFAULT_MODEL_LIST, friendlyModelName } from './models';
import { DiscoveredModel, Endpoint, ModelRef } from './types';

export interface SmartAideSettings {
	endpoints: Endpoint[];
	defaultModelRef: ModelRef;
	titleModelRef: ModelRef;
	modelRecents: ModelRef[];
	systemPrompt: string;
	autoApproveWrites: boolean;
	metaDir: string;
	/** One-time UI flag: has the user seen the "@ now pins notes as context" tip? */
	hasSeenMentionTip: boolean;
	/** Apply cache_control to system + tools when calling Anthropic-native endpoints. */
	anthropicPromptCaching: boolean;
}

export const DEFAULT_META_DIR = 'Meta';
export const chatsDirFor = (metaDir: string): string => `${metaDir}/chats`;
export const skillsDirFor = (metaDir: string): string => `${metaDir}/skills`;
export const internalDirFor = (metaDir: string): string => `${metaDir}/.smart-aide`;

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
	return {
		id: OPENROUTER_ID,
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		apiKey,
		models: models && models.length > 0 ? models : [...DEFAULT_MODEL_LIST],
	};
}

export const DEFAULT_SETTINGS: SmartAideSettings = {
	endpoints: [defaultOpenRouterEndpoint()],
	defaultModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
	titleModelRef: { endpointId: OPENROUTER_ID, slug: DEFAULT_MODEL },
	modelRecents: [],
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	autoApproveWrites: false,
	metaDir: DEFAULT_META_DIR,
	hasSeenMentionTip: false,
	anthropicPromptCaching: true,
};

/**
 * Migrate legacy settings (single OpenRouter key + flat model list) into the
 * multi-endpoint schema. Idempotent.
 */
export function migrateSettings(raw: Record<string, unknown> | null | undefined): SmartAideSettings {
	const r = (raw ?? {}) as Record<string, unknown>;

	if (Array.isArray(r.endpoints) && r.endpoints.length > 0) {
		return {
			endpoints: r.endpoints as Endpoint[],
			defaultModelRef: (r.defaultModelRef as ModelRef) ?? DEFAULT_SETTINGS.defaultModelRef,
			titleModelRef: (r.titleModelRef as ModelRef) ?? (r.defaultModelRef as ModelRef) ?? DEFAULT_SETTINGS.titleModelRef,
			modelRecents: Array.isArray(r.modelRecents) ? (r.modelRecents as ModelRef[]) : [],
			systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : DEFAULT_SYSTEM_PROMPT,
			autoApproveWrites: typeof r.autoApproveWrites === 'boolean' ? r.autoApproveWrites : false,
			metaDir: typeof r.metaDir === 'string' ? normalizeMetaDir(r.metaDir) : DEFAULT_META_DIR,
			hasSeenMentionTip: typeof r.hasSeenMentionTip === 'boolean' ? r.hasSeenMentionTip : false,
			anthropicPromptCaching: typeof r.anthropicPromptCaching === 'boolean' ? r.anthropicPromptCaching : true,
		};
	}

	const legacyKey = typeof r.apiKey === 'string' ? r.apiKey : '';
	const legacyModels = Array.isArray(r.models) ? (r.models as string[]) : undefined;
	const legacyDefault = typeof r.defaultModel === 'string' ? r.defaultModel : DEFAULT_MODEL;
	const legacyTitle = typeof r.titleModel === 'string' ? r.titleModel : legacyDefault;
	const legacyRecents = Array.isArray(r.modelRecents) ? (r.modelRecents as unknown[]) : [];

	const endpoint = defaultOpenRouterEndpoint(legacyKey, legacyModels);
	const recents: ModelRef[] = legacyRecents
		.map((v): ModelRef | null => {
			if (typeof v === 'string') return { endpointId: OPENROUTER_ID, slug: v };
			if (v && typeof v === 'object' && 'slug' in v) return v as ModelRef;
			return null;
		})
		.filter((v): v is ModelRef => v !== null);

	return {
		endpoints: [endpoint],
		defaultModelRef: { endpointId: OPENROUTER_ID, slug: legacyDefault },
		titleModelRef: { endpointId: OPENROUTER_ID, slug: legacyTitle },
		modelRecents: recents,
		systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : DEFAULT_SYSTEM_PROMPT,
		autoApproveWrites: false,
		metaDir: DEFAULT_META_DIR,
		hasSeenMentionTip: false,
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

export function previewSystemPrompt(prompt: string): string {
	const flat = prompt.replace(/\s+/g, ' ').trim();
	return flat.length > 120 ? flat.slice(0, 117) + '…' : flat;
}

export type { DiscoveredModel };
