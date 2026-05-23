# Smart Aide — project guide for agents

AI chat plugin for Obsidian. Tool-mediated search and writes, auto-loading skills, Pi-format chat history with branching. Released via BRAT; targets desktop + iPhone.

The global rules in `~/.agents/AGENTS.md` apply (no automatic commits, no GitHub comments without permission, no AI self-references, simplicity first, zero comments, scope discipline, etc.). This file adds project-specific context.

## Source layout

Everything lives in `src/`. One concept per file — don't merge back into one mega-file.

- `main.ts` — plugin entry. Loads settings (with migration), registers the chat view, ensures a right-sidebar leaf on layout-ready, wires command palette entries.
- `view.ts` — `ChatView extends ItemView`. Top bar (clickable title + new-chat icon), message stream (citation cards + research chips), composer (auto-grow textarea, `@`-mention picker, drag-drop wikilinks), per-turn assembly + persistence.
- `storage.ts` — Pi session format v3 reader/writer. JSONL files under `<vault>/sys/chats/`. Entry IDs are 8-char hex; active leaf tracked implicitly via parent-id walks (no `.head` sidecar).
- `tools.ts` — Tool registry: `search_vault`, `read_note`, `list_recent`, `get_backlinks`, `write_note`, `append_to_note`, `delete_note`, `load_skill`. Path-allowlist guard blocks `.obsidian/`, `sys/.smart-aide/`, `sys/chats/`, absolute, parent-relative.
- `provider.ts` — OpenAI-compatible streaming (`streamChat`, `runTurn`) + model catalog discovery (`discoverModels`). Same single code path for every endpoint.
- `settings.ts` — `SmartAideSettings` shape, legacy-schema migration, settings tab UI (Endpoints → Models → System prompt).
- `picker-models.ts`, `picker-notes.ts` — `FuzzySuggestModal` subclasses for model picking and `@`-mention.
- `modal-endpoint.ts`, `modal-add-endpoint.ts`, `modal-rename-chat.ts` — Obsidian `Modal` subclasses for endpoint editing, template-based endpoint creation, and chat renaming.
- `skills.ts` — `SkillRegistry`. Reads from a single vault-relative directory (default `sys/skills/`, configurable via `settings.skillsDir`). Same path on desktop and mobile — no Node-fs fallback. Exposes a manifest for the system prompt.
- `models.ts` — friendly-name map (`anthropic/claude-haiku-4.5` → "Claude Haiku 4.5"), default model list, recents helper.
- `types.ts` — domain types: `Endpoint`, `DiscoveredModel`, `ModelRef`, `AgentMessage`, content blocks, Pi `Entry` variants, OpenAI message shapes.

## Current code surface

- **8 tools.** Reads: `search_vault` (fuzzy multi-surface, `deepSearch` opt-in), `read_note` (range / section / auto-truncate, fuzzy section), `list_recent`, `get_backlinks`, `load_skill`. Writes (with diff-approval card): `write_note`, `append_to_note`, `delete_note`. Per-turn "approve all writes" override; delete-class always confirms. Approval decisions persist as `custom` entries in the JSONL.
- **Skills.** Single vault directory (`sys/skills/` by default, configurable). Manifest of skill descriptions injected into the cached system prompt; `load_skill(name)` pulls the body on demand and records it as a `custom_message` entry so the chat history shows what the model saw. Don't splice bodies into the system prefix — it breaks prompt caching.
- **Providers.** Multi-endpoint OpenAI-compatible config. Each endpoint is `{id, name, baseURL, apiKey, headers?, models?, discoveredModels?, lastTest?}`. `GET {baseURL}/models` auto-discovery populates the picker. Per-chat `ModelRef = {endpointId, slug}` so the same slug on different endpoints stays unambiguous.
- **Model picker.** Friendly names, recents-at-top, context window + cost + tool support inline per row, endpoint badge when >1 endpoint configured.
- **Message rendering.** Tool calls collapse into a single research chip per turn (`🔍 4 searches · 12 hits`); `read_note` results render as clickable citation cards with deep-link subpath (`path#Heading`), line range, and one-line snippet; intra-turn narration suppressed; copy button on every code block; per-turn token usage in a hover tooltip.
- **Composer.** Enter sends (Shift+Enter newline) on desktop; mobile tap-Send. `@` opens vault-note picker. Drag-dropping a note into the composer inserts `[[wikilink]]`. Thinking dots while waiting first token. Auto-grow textarea.
- **Top bar.** Chat title on the left — click to switch chats, long-press / right-click to rename. `+` icon on the right for new chat.
- **Settings.** Three sections in order: Endpoints (compact rows, edit modal), Models (default chat + title; title collapses to "Same as chat model" when mirrored), System prompt (collapsed by default). Empty-state "Get started" card and endpoint-aware "Get a key" link on first install.
- **Auto-titling.** After the first user/assistant exchange, a single cheap call against `settings.titleModelRef` generates a 4-8 word session title and persists it as a `session_info` entry. Skips if any `session_info` already exists.

## Deferred / open questions

- Sync conflict banner (Obsidian Sync mid-chat collisions).
- Image input (currently text-only).
- Spend caps + cost ledger.
- System-keychain API key storage (currently plaintext in `data.json`).

## Architectural decisions to honor

- **Single responder model.** No router/responder split unless measurement justifies it. Pi has no split and works.
- **Pi session format v3** for chat storage. Reuse Pi's format directly so the `session-manager` skill and the Pi CLI interop.
- **All skill descriptions in the responder's cached system prompt; `load_skill(name)` tool pulls bodies on demand.** Logged as `custom_message` so chat history shows what the model saw.
- **Tools are first-class. Writes require approval with a diff preview** (per-turn "approve all writes" override; delete-class always confirms). Approval state is durable (`custom` entries), not a transient modal.
- **OpenAI-compatible endpoints, multi-endpoint config.** One streaming code path against `{baseURL}/chat/completions` SSE. OpenRouter is the default-installed endpoint; users can add direct providers (OpenAI, Anthropic compat), local servers (oMLX / LM Studio / Ollama), or gateways. Each chat persists a `ModelRef`. Native Anthropic / OpenAI / Google protocols intentionally not adopted — keeps the surface small. Mobile-safe: every endpoint is just `fetch` + SSE.
- **No on-device embedding index on mobile.** Ever. Tool-call grep is the retrieval strategy. This is the architectural bet that distinguishes Smart Aide from Smart Composer (which fails iPhone search because it needs RAG).
- **Skills live in the vault** (`sys/skills/` by default, configurable in settings). Same path on desktop and mobile. Power users who want to share skills with Pi or Claude Code symlink `~/.agents/skills/` → the vault skills dir themselves — the plugin never reaches outside the vault.

## Build / release workflow

**Do not bump versions or cut releases per commit.** This is a solo-user project. Only release when the user explicitly asks to "publish," "release," or "push to BRAT." Commits accumulate at the current published version until then; the manifest/package version reflects the latest released version, not the in-progress state.

```bash
npm run build       # build + typecheck via tsc --noEmit
npm run dev         # watch mode for local dev
```

When asked to release:

1. Bump **both** `manifest.json` AND `package.json` versions.
2. `git add -A && git commit -m "..."`
3. `git push`
4. `npm run build`
5. `gh release create vX.Y.Z main.js manifest.json styles.css --title "..." --notes "..."`

BRAT picks up the new release automatically; user taps "Check for updates" in BRAT settings.

## Secret hygiene

- **Never commit `data.json`.** It contains API keys. Already gitignored, but verify before any commit.
- If you symlink the plugin source into a vault for local dev, make sure `data.json` is gitignored in the plugin repo too — Obsidian writes the file into the plugin folder.
- The OpenRouter API key UI uses `sk-or-v1-...` as a placeholder — that's not a real key.

## Mobile constraints

Confirmed working on iPhone Obsidian (verified 2026-05):
- `fetch` + ReadableStream — streaming, multiple chunks, first-token ~900ms
- `requestUrl` for blocking — actually faster than `fetch` on mobile
- Base64 payloads up to 3MB on both transports

Does **not** work on mobile:
- Any Node API (`fs`, `path`, `child_process`, `require` outside `obsidian`)
- Reading files outside the vault (so skills must be in `<vault>/sys/skills/` on mobile)
- Shell scripts referenced by skills

If you add a desktop-only feature, set `isDesktopOnly: true` in `manifest.json`. We currently target both, so default to `false`.

## Tool design principles

Tools are mini-skills — a small model (Haiku, Flash) reads each tool's description cold and decides what to call and how to fill parameters. Apply these consistently when adding or modifying a tool.

### Principle

**Optimize for small models on iPhone.** Two scarce resources: file IO (slow on cold cache via the Capacitor adapter) and model context (precious for sub-Sonnet tiers). Every tool decision trades against these.

### Pattern

| Concern | Default | Opt-in for more |
| --- | --- | --- |
| Where data comes from | MetadataCache (in-memory) — free even on iPhone | `cachedRead`/`read` (file IO) only when MetadataCache can't answer |
| Result count | Tight (e.g. `maxResults: 10`) | Hard cap higher (e.g. 50) |
| Response shape | Compact; strip undefined fields | Verbose fields only when explicitly requested |
| Per-file content | Truncate above ~60KB to ~25KB + outline | `startLine`/`endLine` to read more |
| Expensive scan modes | Off (`deepSearch: false`) | Boolean opt-in with model-visible hint on empty results |

### Worked examples in tool descriptions

Tool descriptions carry 4–6 lines mapping user intent → call shape:

```
"find that piece on weekly reviews" -> query="weekly review"
"the note where I wrote 'eventual consistency'" -> query="eventual consistency"
"find notes tagged book" -> tag="book"
"recent notes about deadlines" -> query="deadline", sinceDays=30
```

This is the dominant device for steering small models. Better than a paragraph of rules.

### Self-correcting affordances

Every tool that can return empty (search, find) and every tool that can hit a limit (truncated read) carries a `hint` field in the response telling the model what to try next:

```json
{ "matches": 0, "results": [], "hint": "0 matches. Try: set deepSearch=true to also scan note content; try a single key word; issue parallel calls with related terms." }
```

### Prefer parallel calls over complex parameters

When the model would benefit from variation (e.g. synonym expansion: `deep work` / `deepwork` / `flow`), tell it in the description to issue parallel tool calls — don't add a `synonyms: string[]` parameter. Parallel calls cost one round-trip total and use no extra API surface.

### Don't add affordances dumb models will misuse

Check every new parameter against: "will Haiku-class actually use this correctly?"

- ✅ `section: "Setup"` — natural, model uses user's words
- ✅ `deepSearch: true` opt-in — boolean, hint guides usage
- ❌ `paths: string[]` (batched reads) — easy to send 10 paths and flood context
- ❌ Query-language strings (`"tag:X AND content:Y"`) — small models butcher syntax

### Checklist when adding or modifying a tool

1. Cheap-vs-expensive: is the default path in-memory only? Is expensive work behind an opt-in?
2. Worked examples: does the description carry 4+ "user said X → call with Y" examples?
3. Empty/limit hints: does the response tell the model how to recover?
4. Tight defaults: maxResults, payload shape, per-file caps?
5. Each parameter: would a small model use it correctly?
6. Parallel-call story: is it obvious from the description when to issue multiple calls?

## Code style for this project (in addition to global rules)

- TypeScript strict mode. `tsconfig.json` has `strictNullChecks` on.
- No comments unless explaining a non-obvious WHY. Naming carries the WHAT.
- Don't introduce dependencies casually. Current deps: `obsidian` (peer), `esbuild`, `tslib`, `typescript`, `@types/node`, `builtin-modules`.
- Keep `main.js` build output small. One concept per file in `src/` — the file split is intentional.

## When uncertain

- About an Obsidian API: read `node_modules/obsidian/obsidian.d.ts` — that's the canonical signature source.
- About what to build next: the **Deferred / open questions** list above, then ask the user.
- About user preferences: ask. The user is decisive and prefers direct recommendations over menus.
