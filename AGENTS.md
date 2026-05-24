# Smart Aide — project guide for agents

AI chat plugin for Obsidian. Tool-mediated search and writes, auto-loading skills, Pi-format chat history with branching. Released via BRAT; targets desktop + iPhone.

The global rules in `~/.agents/AGENTS.md` apply (no automatic commits, no GitHub comments without permission, no AI self-references, simplicity first, zero comments, scope discipline, etc.). This file adds project-specific context.

## Source layout

Everything lives in `src/`. One concept per file — don't merge back into one mega-file.

- `main.ts` — plugin entry. Loads settings (with migration), registers the chat view, collapses duplicate sidebar leaves on layout-change, wires command palette entries.
- `view.ts` — `ChatView extends ItemView`. Top bar (clickable chat title + new-chat icon — tab title is always "Smart Aide"), burst-grouped message stream, composer (auto-grow textarea starting at 1 row, `@`-mention picker that pins, drag-drop pins, edit-and-fork banner), unified context strip (pins + skill chips + AGENTS badge), bottom toolbar (model chip + token chip with expandable popover), per-turn assembly + persistence, `collectApprovals` → `runOneToolCall` dispatch (writes go through ONE batched card, deletes confirm individually).
- `view-helpers.ts` — pure helpers (no DOM): line diff for approval previews, message/role helpers, `groupChainIntoBursts` (the core of the burst renderer), `buildResearchHeadline`, `summarizeToolResult`, token estimation (`estimateTokens`, `sumBreakdown`, `formatCostUsd`), and `TokenBreakdown` shape.
- `view-render.ts` — render helpers for the message stream: `renderResearchChip` (collapsed/expanded activity, includes skill loads), `renderCitationCard` (deep-linked read_note results), `renderImageBlock`, generic tool-call/result blocks, `addCopyButtons` for code fences.
- `view-approval.ts` — `requestApproval` (single delete) + `requestBatchedWriteApprovals` (one card, N writes, per-item checkboxes, optional "auto-approve future writes in this turn" toggle). Renders fixed-bottom while pending; releases to static flow once decided.
- `view-autotitle.ts` — generates the chat title after the first exchange via a cheap call to `settings.titleModelRef`.
- `context-pins.ts` — `PinnedContext`. In-memory pinned-note list for the active chat; each turn re-reads pinned files and prepends their content to the user message. Per-file cap mirrors `read_note` auto-truncation.
- `storage.ts` — Pi session format v3 reader/writer. JSONL files under `<vault>/{metaDir}/chats/` (default `Meta/chats/`). Lazy file creation (no file until the first `appendEntry`). `cleanupEmptyChats` sweeps on plugin load. `deleteChat(path)` removes a single session file (called by the picker's × button). Entry IDs are 8-char hex; active leaf tracked implicitly via parent-id walks.
- `tools.ts` — Tool registry: `search_vault`, `read_note`, `list_recent`, `get_backlinks`, `write_note`, `append_to_note`, `delete_note`, `load_skill`. Path-allowlist guard blocks `.obsidian/`, `{metaDir}/.smart-aide/`, `{metaDir}/chats/`, absolute, parent-relative — guard reads `metaDir` from `ToolContext` so the forbidden prefixes track whatever the user configures. `read_note` and all write/delete tools enforce `.md` extension (Obsidian's only first-class file type for notes; attachments come in via the paperclip/paste path). `write_note` strips a leading `# <Filename>` line that duplicates Obsidian's inline title.
- `providers/` — protocol abstraction over chat endpoints. `index.ts` exports `providerFor(endpoint)` which dispatches on `endpoint.protocol`: undefined / `'openai-compat'` → `openai-compat.ts` (OpenAI-style SSE against `{baseURL}/chat/completions`), `'anthropic'` → `anthropic.ts` (native `/v1/messages` with prompt-caching), `'gemini'` → `gemini.ts` (native `/v1beta/models/*:streamGenerateContent`). `types.ts` defines the cross-protocol `Provider`, `StreamEvent`, `TurnRequest`, `ToolDescriptor`, `TurnUsage` shapes that the view consumes uniformly.
- `settings.ts` — `SmartAideSettings` shape, legacy-schema migration, `DEFAULT_SYSTEM_PROMPT`, `metaDir`/`chatsDirFor`/`skillsDirFor`/`internalDirFor` helpers, `resolveModelRef`. Pure types/data — no UI.
- `settings-tab.ts` — `SmartAideSettingsTab extends PluginSettingTab`. Renders seven sections in order: Endpoints → Models → Storage → Skills → Sample skills → Approvals → System prompt. Endpoint editing is an in-tab sub-page, not a modal (state in `editingEndpointId`). Sample-skills section drives one-click install of bundled `sample-skills/` into the user's skills folder.
- `model-picker-filter.ts` — pure helpers (`buildModelPickerItems`, `ModelItem`/`ToggleItem` types) consumed by `picker-models.ts`. Tested in isolation without the picker DOM.
- `sample-skills/` — bundled starter skills (`daily-note`, `meeting-notes`, `weekly-review`, `process-inbox`, `moc-builder`, `handwriting-ocr`). `index.ts` exposes the list; `types.ts` exposes `installSample(vault, dir, skill, { overwrite? })` + `readSampleStatus`. The Settings → Sample skills section calls these to write the SKILL.md into the user's `${metaDir}/skills/<name>/` and track install state.
- `endpoint-editor.ts` — `renderEndpointEditor()` inline UI: name, base URL, API key (with get-a-key link), Test connection (persisted result), Refresh, manual model list, advanced headers, two-click delete. Called by settings.ts when `editingEndpointId` is set.
- `picker-models.ts`, `picker-notes.ts` — `FuzzySuggestModal` subclasses for model picking and the full-vault `@`-mention picker (pins on select; see Composer for semantics). The `/`-slash skill picker is NOT a modal — it's an inline popover rendered inside `vk-composer` (see Composer + slash autocomplete below).
- `modal-add-endpoint.ts`, `modal-rename-chat.ts` — Obsidian `Modal` subclasses for the template chooser and chat renaming (the only modals left after the endpoint-editor sub-page conversion).
- `skills.ts` — `SkillRegistry`. Reads from a single vault-relative directory (default `Meta/skills/`, derived from `settings.metaDir`). Same path on desktop and mobile — no Node-fs fallback. Exposes a manifest for the system prompt. Frontmatter parser supports the Anthropic Agent Skills cross-tool standard fields: required `name` + `description`, optional `mobile`, optional `user-invocable: true` (surfaces as `/<name>` in the composer), optional `allowed-tools: [...]` (scopes the tool registry for the invocation turn). `allowed-tools` accepts both flow `[a, b]` and block `\n  - a\n  - b` styles.
- `agents-md.ts` — `AgentsMdRegistry`. Reads up to two `AGENTS.md` files ([agents.md](https://agents.md/) cross-tool standard): `<vaultRoot>/AGENTS.md` (the location other tools — Pi, Claude Code, Codex — already use) and `${metaDir}/AGENTS.md` (plugin-specific augmentation). Outer first, inner second, concatenated with a horizontal rule and per-file headers so the closer file wins on overlap. Either or both may be absent. If `metaDir` resolves to the vault root, the file is read once. Appended to the system prompt by `composeSystemPrompt()` between the base prompt and the skill manifest, so the model gets vault-specific context (layout, tags, projects, paths to avoid) before the skill catalog.
- `models.ts` — friendly-name map (`anthropic/claude-haiku-4.5` → "Claude Haiku 4.5"), default model list, recents helper.
- `image-helpers.ts` — pure helpers + `attachImageToVault(app, bytes, name, mime)`. Saves bytes via `app.fileManager.getAvailablePathForAttachment` (Obsidian's configured attachment folder), returns an `ImageBlock { type:'image', path, mime }`. HEIC/HEIF rejected — most cloud vision models don't accept them as-is.
- `types.ts` — domain types: `Endpoint`, `DiscoveredModel`, `ModelRef`, `AgentMessage`, content blocks, Pi `Entry` variants, OpenAI message shapes.

## Current code surface

- **8 tools.** Reads: `search_vault` (word-tokenized BM25 over filename + headings + tags, opt-in `deepSearch` extends to note bodies with word-boundary phrase matching; surfaces are fused via Reciprocal Rank Fusion with `k=60`; an auto fuzzy-character-order pass fires when the BM25 path returns nothing — response flags `fuzzyFallback=true` so the model treats those hits as approximate. Lucene defaults `k1=1.2`/`b=0.75`. See `src/tools.ts:12-29` for tuning constants), `read_note` (range / section / auto-truncate, fuzzy section), `list_recent`, `get_backlinks`, `load_skill`. Writes: `write_note`, `append_to_note`, `delete_note`. Writes in one turn batch into a **single** approval card with per-item checkboxes ("Approve selected" / "Reject all" + an optional "auto-approve future writes in this turn" toggle). Deletes still confirm one-at-a-time (one wrong delete > five wrong appends). `settings.autoApproveWrites` (dangerous mode) bypasses the card for write/append; delete still confirms. Approval decisions persist as `custom` entries in the JSONL — the audit trail. `write_note` post-processes content to strip a leading `# <Filename>` line that duplicates Obsidian's inline title (applied in both preview and execute so the diff matches).
- **Skills.** Single vault directory (`Meta/skills/` by default, derived from `settings.metaDir` — common alternative `sys/skills/`). Manifest of skill descriptions injected into the cached system prompt; `load_skill(name)` pulls the body on demand and records it as a `custom_message` entry so the chat history shows what the model saw. Don't splice bodies into the system prefix — it breaks prompt caching. Two invocation paths:
  - **Model-invoked** (default): the model calls `load_skill(name)` when a request matches a manifest description.
  - **User-invoked** (`user-invocable: true` in frontmatter): the user types `/<name>` in the composer to summon the skill directly. Typing `/` in an empty composer opens a fuzzy picker over user-invocable skills. The skill body is persisted as a `custom_message` of customType `skill-invocation` **before** the user message in the chain, so the model sees the skill body as the context for that turn. `allowed-tools: [...]` in the skill frontmatter scopes the tool registry for the whole assistant loop following the invocation; subsequent user turns (without a slash) revert to the full registry. One-shot semantics — the override applies to that burst only.
- **Vault context (AGENTS.md).** Reads `<vaultRoot>/AGENTS.md` (cross-tool standard location — Pi, Claude Code, Codex all look here) and `${metaDir}/AGENTS.md` (plugin-specific augmentation). Both optional; if both exist, root first then metaDir, separated by a horizontal rule with file headers so the model can tell them apart. Appended to the system prompt between the base prompt and the skill manifest. Purpose: user-maintained vault context — folder layout, tag conventions, ongoing projects, paths to leave alone. Reloaded with the same Reload button as skills and on `metaDir` change.
- **Providers.** Multi-endpoint OpenAI-compatible config. Each endpoint is `{id, name, baseURL, apiKey, headers?, models?, discoveredModels?, lastTest?}`. `GET {baseURL}/models` auto-discovery populates the picker (fires 1.5s after API-key paste). Per-chat `ModelRef = {endpointId, slug}` so the same slug on different endpoints stays unambiguous.
- **Model picker.** Friendly names, recents > curated (in `endpoint.models`) > discovered alphabetical. Context window + cost ($/M) + tool support inline per row; endpoint badge when >1 endpoint configured.
- **Burst-grouped rendering.** One user message produces one "burst": their bubble, an optional **activity card** (collapsed-by-default research chip listing every tool call AND query AND skill load across consecutive tool-only turns), and the final assistant text. Citation cards (`read_note` results) render outside the chip — always visible. Skill loads appear inside the chip detail as `🧠 loaded skill: <name>`. Slash invocations appear as `🪄 invoked /<name>` and prepend `/<name>` to the activity headline; the activity chip is shown for invocations even when no tool calls happened. Role labels (USER/ASSISTANT) are dropped — alignment + the burst boundary carries role. Markdown is chat-tight (smaller headings, ~4px list-item spacing); blockquotes use a thin accent bar with NO background fill so the model's routine `> quote` doesn't dominate. Native text selection enabled (long-press on iOS → Copy / Look Up). Per-burst token tooltip on the activity card; per-turn tooltip on the final answer.
- **Composer.** Enter or Shift+Enter both send on desktop; mobile tap-Send. Textarea starts at 1 row and grows on input. `@` opens a full-vault fuzzy picker that **pins** the selected note as context (not insert wikilink — that semantic moved to Obsidian's native `[[` picker; one-time tooltip on first use). Slash autocomplete (see next bullet) handles `/`. Drag-dropping a vault `.md` path into the composer or the context strip also pins. Thinking dots while waiting first token. Pencil on every past user message → enters edit-and-fork mode (composer loads with that text, a "Editing — Send to fork / Cancel" banner appears, the message + everything after it disappears from the rendered chain). Send creates a sibling with the original's parentId; the original branch stays in the JSONL but drops out of the active leaf.
- **Slash autocomplete.** Inline popover rendered inside `vk-composer` (anchored above the input card via `position: absolute; bottom: 100%`). Activates while the whole textarea matches `/<name>` with no trailing space — driven by `input` events through the pure `parseSlashContext` helper. Filters via `filterSkillsForSlash` (prefix matches before substring, case-insensitive). 5 items on desktop, 4 on mobile, 44pt-min row height for touch. ↑/↓ navigates (wraps), Enter or Tab commits (`/<name> ` + cursor at end), Esc dismisses without committing (typed text stays). `mousedown` (not `click`) commits so the textarea doesn't blur and iOS keeps the keyboard up. Document-level click-outside dismisses. Once the user types a space (`/edit `) the popover closes — slash is "settled" and send-time `parseSlashInvocation` finishes the job. No modal: typing `/` with no further input shows all user-invocable skills in the same popover, so there's nothing to discover separately.
- **Unified context strip** (above the textarea). Holds pinned-note chips (📌 with token count, × to unpin), loaded-skill chips (🧠 click to open the skill file), an AGENTS badge (📚 when `<vault>/AGENTS.md` is loaded), an `unpin all` button when 3+ pins, and a `+ note` button (full-vault fuzzy picker). The model sees the same context the user sees in this strip.
- **Two-layer token visibility** (bottom toolbar). Ambient chip shows `N%` of the model's context window — faint until 70%, muted at 70–90%, warning above 90% (configurable in `refreshTokenChip`). Tap the chip → popover with the breakdown (System prompt / Vault context / Skill catalog / Pinned notes / Loaded skills / Chat history / Composer text) plus pre-send projection (`Next turn ≈ Xk · $0.09`) and cumulative session-so-far. Dollar costs computed from `endpoint.discoveredModels[i].promptPrice`/`completionPrice` (per-million); fall back to tokens-only when pricing is unknown. Cache % (when reported by the model) moves into the popover footer.
- **Empty state.** Two-line teaching block: capabilities sentence + `🧠 N skills available · vault context loaded` row when applicable. Pins are intentionally NOT listed here — the context strip above the composer is the source of truth for pins, so duplicating them risks going stale on unpin. Sets the trust frame before turn 1.
- **Image attach.** Paperclip button in the composer toolbar (file picker, JPEG/PNG/GIF/WebP); camera button on mobile (`<input capture="environment">`). Paste an image from the clipboard (Cmd+Shift+4 → paste) or drag-drop image files from Finder/Explorer / vault attachments. New images get saved into Obsidian's configured attachment folder via `app.fileManager.getAvailablePathForAttachment`; the JSONL records `ImageBlock { path, mime }`, not bytes, so chats stay small. On send, `storage.toOpenAIMessages` reads the bytes and inlines them as base64 `image_url` data URLs (the OpenAI-compat multi-part content shape). Past image blocks render as `<img>` with `vault.getResourcePath`. Capability gating is **not** implemented yet — sending an image to a text-only model may silently strip on some gateways; deferred until it bites.
- **Top bar.** Chat title on the left — click to open the chat picker, long-press / right-click to rename the current chat. `+` icon on the right for new chat. The chat picker is a `FuzzySuggestModal` (`ChatPickerModal` in `main.ts`); each row has a small × button with two-click confirm (first click → "delete?" pill, auto-reverts after 3s; second click → `storage.deleteChat(path)` and removes the row). Clicks on the × use `pointerdown`/`mousedown`/`touchstart` stopPropagation so the modal doesn't commit selection underneath. Deleting the currently-open chat triggers `view.newChat()` on the matching leaf; picker auto-closes when the last chat is removed. The Obsidian tab header (above the in-view bar) always reads "Smart Aide" via `getDisplayText()` — brand identity stays at the tab level, the in-view title is just the current chat name. Force-instantiated on plugin load so the panel picker shows the proper icon + label instead of Obsidian's deferred-view ghost placeholder.
- **Settings.** Seven sections in order: Endpoints (compact rows; Edit opens an in-tab sub-page, not a modal — `editingEndpointId` state in `SmartAideSettingsTab`), Models (default chat + title; title collapses to "Same as chat model" when mirrored), Storage (Meta folder — single vault-relative path that chats/skills/internal/AGENTS.md all derive from; default `Meta`, common alternative `sys`; second blurb in this section documents `${metaDir}/AGENTS.md`), Skills (Reload button reloads both skills and AGENTS.md), Sample skills (one-click install of bundled starters from `src/sample-skills/` into the user's skills folder, with per-skill state: not installed / installed / modified — "modified" shows an Open link to the user's edited copy), Approvals (auto-approve writes toggle), System prompt (collapsed by default). Empty-state "Get started" card and endpoint-aware "Get a key" link on first install.
- **Approval cards.** All writes for one turn batch into ONE card (`requestBatchedWriteApprovals`) with a checkbox per item, "Approve selected", "Reject all", and an optional "auto-approve future writes in this turn" toggle. Deletes get their own single-item `requestApproval` card. Pending cards use `position: fixed` (bottom-anchored above the composer, max 60dvh, drop-shadow) so they can never be hidden by scroll on mobile. Decided cards (`vk-approval-decided-*`) release to `position: static` and flow into history.
- **Auto-titling.** After the first user/assistant exchange, a single cheap call against `settings.titleModelRef` generates a 4-8 word session title and persists it as a `session_info` entry. Skips if any `session_info` already exists.

## Deferred / open questions

- Sync conflict banner (Obsidian Sync mid-chat collisions).
- Capability gating for image attach (currently sends image blocks to any model; silent-strip risk on some gateways/text-only models).
- PDF input (Gemini-native, or pdf.js → page-images locally — both have real costs; see chat history).
- Spend caps. Token projection + per-turn / cumulative cost display landed; hard caps that block sending past a threshold haven't.
- System-keychain API key storage (currently plaintext in `data.json`).
- Completion-token estimate in the projection is a fixed 500. A rolling average from past turns in the same chat would be more accurate.

## Architectural decisions to honor

- **Single responder model.** No router/responder split unless measurement justifies it. Pi has no split and works.
- **Pi session format v3** for chat storage. Reuse Pi's format directly so the `session-manager` skill and the Pi CLI interop.
- **All skill descriptions in the responder's cached system prompt; `load_skill(name)` tool pulls bodies on demand.** Logged as `custom_message` so chat history shows what the model saw. User-invocable skills (`user-invocable: true`) are also summonable as `/<name>` in the composer — same skill primitive, two invocation paths. We deliberately did NOT introduce a separate "agent" or "command" concept: the cross-tool Agent Skills standard already carries `user-invocable` + `allowed-tools`, and matching the standard keeps skills portable to Pi / Claude Code / Codex via symlink.
- **Tools are first-class. Writes require approval with a diff preview** (per-turn "approve all writes" override; delete-class always confirms). Approval state is durable (`custom` entries), not a transient modal.
- **Multi-endpoint config behind a provider abstraction.** Each endpoint is `{id, name, baseURL, apiKey, protocol?, headers?, models?, discoveredModels?, lastTest?}`. `providers/index.ts:providerFor(endpoint)` dispatches on `protocol`: default / `'openai-compat'` (OpenRouter, OpenAI direct, Anthropic-compat, local servers like oMLX / LM Studio / Ollama, generic gateways) → SSE against `{baseURL}/chat/completions`; `'anthropic'` → native `/v1/messages` (lets us turn on prompt caching properly); `'gemini'` → native `/v1beta/models/*:streamGenerateContent`. The view consumes a uniform `Provider` interface from `providers/types.ts` regardless of which protocol fired. Each chat persists a `ModelRef`. Native protocols were added (0.2.4 Anthropic, 0.2.5 Gemini) when OpenAI-compat couldn't expose features we wanted (caching headers, system-instructions block) — adding more is fine as long as the new provider implements the `Provider` interface. Mobile-safe: every protocol is just `fetch` + SSE.
- **No on-device embedding index on mobile.** Ever. Tool-call grep is the retrieval strategy. This is the architectural bet that distinguishes Smart Aide from Smart Composer (which fails iPhone search because it needs RAG).
- **Skills live in the vault** (`Meta/skills/` by default, derived from `settings.metaDir`). Same path on desktop and mobile. Power users who want to share skills with Pi or Claude Code symlink `~/.agents/skills/` → the vault skills dir themselves — the plugin never reaches outside the vault.

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
- Reading files outside the vault (so the skills directory must be vault-relative on every platform)
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
- Don't introduce dependencies casually. Current deps: `obsidian` (peer), `esbuild`, `tslib`, `typescript`, `@types/node`, `builtin-modules`, `vitest`, `@vitest/coverage-v8`.
- Keep `main.js` build output small. One concept per file in `src/` — the file split is intentional.

## When uncertain

- About an Obsidian API: read `node_modules/obsidian/obsidian.d.ts` — that's the canonical signature source.
- About what to build next: the **Deferred / open questions** list above, then ask the user.
- About user preferences: ask. The user is decisive and prefers direct recommendations over menus.
