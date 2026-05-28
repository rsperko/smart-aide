# Settings reference

Settings live in **Settings → Community plugins → Smart Aide**. The tab is split into seven sections in fixed order: Overview, Providers, Chat models, Vault data, Skills, Safety, Advanced. This page covers every setting in each section, every default, and every behavior that depends on Obsidian core settings rather than Smart Aide's own.

If you only read one section: [How Smart Aide uses Obsidian's configuration](#how-smart-aide-uses-obsidians-configuration). Several behaviors are driven by Obsidian-native settings you may already have configured.

## Overview

A landing card with two parts:

- **Banner** — surfaces the one thing blocking you. "Add an API key" before any key is set; "<provider> didn't connect" if a connection test failed; "Pick favorite models" when no models are favorited yet.
- **Status rows** — one line each for Providers, Chat model, Favorites, Vault data, Skills, Safety. Each row's action button scrolls to the matching section.

No editable settings here. The Overview is read-only navigation.

## Providers

A provider is one chat endpoint — OpenRouter, OpenAI, native Anthropic (`/v1/messages`), native Gemini (`/v1beta/models/*:streamGenerateContent`), or any OpenAI-compatible service (local servers, custom gateways). You can configure as many as you want — each chat picks a model from one provider via a `ModelRef = { endpointId, slug }` pair, so the same model name on different providers stays unambiguous.

Click **Edit** on a row to open the endpoint editor (a sub-page, not a modal). Click **+ Add provider** at the bottom to pick a template (OpenRouter, OpenAI, Anthropic, Gemini, Custom).

### Endpoint editor

| Setting | Description | Default |
| --- | --- | --- |
| Name | Display label in pickers and the model chip. | Template-derived (e.g. "OpenRouter"). |
| Protocol | `openai-compat`, `anthropic`, or `gemini`. Selected by the template at creation; OpenRouter / OpenAI direct / local servers all use `openai-compat`. | `openai-compat` |
| API URL | Root URL Smart Aide calls. Field label adapts to the selected protocol ("Anthropic API URL", "Google AI Studio API URL", "OpenAI API URL"). Conventions match the corresponding SDKs — see [URL contract per protocol](#url-contract-per-protocol). A live `Calls: ...` preview below the field shows the exact URL that will be hit. | Template-derived. |
| API key | Per-device secret. Stored outside `data.json` so synced vaults don't ship keys. See [Where settings are stored](#where-settings-are-stored). | Empty. |
| Test connection | Validates that **chat will work**, not just that metadata is reachable. Probes both `/v1/models` and the chat route in parallel and reports based on whichever subset of the protocol is actually serving requests. See [Test connection semantics](#test-connection-semantics). | — |
| Refresh models | Re-runs `/v1/models` discovery on demand. See [Model discovery and caching](#model-discovery-and-caching) for when this runs. | — |
| Manual model list | Promoted to the top of the editor when discovery returns nothing (common on gateways that passthrough chat but not metadata — see Shopify proxy below). When discovery works, lives under **Advanced** as a power-user override. One slug per line. | Empty. |
| Custom headers (advanced) | Extra HTTP headers sent on every request. JSON object. Used for self-hosted gateways that require auth headers beyond `Authorization`. | Empty. |
| Delete | Two-click confirm. Disabled when there's only one endpoint. | — |

### URL contract per protocol

Each protocol's "API URL" field follows the convention of the corresponding vendor's SDK. The plugin appends the protocol's standard suffix internally. The live `Calls: …` preview below the field shows the resolved URL.

| Protocol | What you provide | Convention matches | Plugin appends |
| --- | --- | --- | --- |
| `anthropic` | Root URL (e.g. `https://api.anthropic.com` or `https://gateway.example/apis/anthropic`) | Anthropic SDK `base_url`, Claude Code `ANTHROPIC_BASE_URL`, LiteLLM proxy | `/v1/messages` (chat), `/v1/models` (discovery) |
| `gemini` | Root URL (e.g. `https://generativelanguage.googleapis.com`) | google-genai unified SDK `base_url` | `/v1beta/models/{model}:streamGenerateContent` (chat), `/v1beta/models` (discovery) |
| `openai-compat` | Root URL **including** `/v1` (e.g. `https://api.openai.com/v1` or `https://openrouter.ai/api/v1`) | OpenAI SDK `base_url`, OpenRouter docs, LiteLLM proxy | `/chat/completions` (chat), `/models` (discovery) |

The `/v1` inconsistency between protocols is an ecosystem-level choice, not a plugin choice. OpenAI's ecosystem put `/v1` on the user side of the boundary; Anthropic's and Google's put it on the SDK side. Smart Aide mirrors each ecosystem's convention so the same baseURL value works in the corresponding SDK without modification.

### Test connection semantics

Test doesn't just answer "can I list models?" — it answers "**will chat work?**" That distinction matters because some gateways mount `/v1/models` at a different path than the chat route. Test would otherwise report a false ✓ when metadata happens to be reachable but the chat route is blocked.

For Anthropic-native endpoints, Test probes both `/v1/models` and `/v1/messages` in parallel:

| `/v1/models` | `/v1/messages` | Result |
| --- | --- | --- |
| 200 | 200 | ✓ `N models` |
| any | 200 | ✓ `messages endpoint reachable` |
| 200 | blocked | ✗ `chat blocked at /v1/messages …` (with the upstream's actual reason) |
| both fail | both fail | ✗ `HTTP <messages-status>` |

The messages probe sends a 1-token request (`max_tokens: 1`, single-character prompt) using either the first manually-typed slug or a broadly-valid fallback (`claude-haiku-4-5`). It deliberately does **not** use a discovered slug, because discovered slugs can be stale relative to the current baseURL.

For OpenAI-compat and Gemini-native, Test currently runs only the metadata probe — those protocols don't show the gateway-mount-divergence pattern that motivates the dual probe.

### Model discovery and caching

Smart Aide calls `/v1/models` (or its protocol-specific equivalent) **only on explicit user actions**:

1. **API key edit** in the endpoint editor — fires 1.5s after the last keystroke (debounced). Cancels itself if you keep typing or change the URL / protocol before the timer fires.
2. **Test connection** button click.
3. **Refresh** icon click on the Models row.

There is no background refresh, no schedule, no "refresh on Obsidian start," no TTL. Once `/v1/models` returns successfully, the result is stored in `endpoint.discoveredModels` (under `vk:device-settings` in localStorage) and persists indefinitely across Obsidian restarts. The Models row shows a freshness label (`"N discovered · refreshed 3 days ago"`); when you want fresh data, click Refresh.

The discovered list is **cleared** in only a few situations:

- The protocol dropdown changes (different wire shape — the previous list is no longer meaningful).
- A successful discovery overwrites the list with a new result.
- The user explicitly wipes localStorage.

This policy matches the cadence at which model catalogs actually change — vendors ship new models on a months-or-quarters cadence, so silent daily refreshes wouldn't catch anything users miss by clicking Refresh once a month.

#### Gateways that don't expose `/v1/models`

Some Anthropic-compatible gateways serve `/v1/messages` but not `/v1/models`. Examples: the Shopify AI proxy at `https://proxy-shopify-ai.local.shop.dev/apis/anthropic` mounts only chat routes under `/apis/anthropic/`; metadata lives at the host root in a different shape (universal catalog, OpenAI-shape) and isn't appropriate to pull into an Anthropic-protocol endpoint.

The plugin handles this by promoting the **Manual model slugs** section from Advanced to the top of the endpoint editor with explanatory copy. Type the slugs you want available, one per line. The chat path itself works fine — only model discovery is unavailable.

File a feature request with the gateway's maintainers if you want `/v1/models` support; it's a single-route addition that mirrors the existing chat-route pattern.

## Chat models

| Setting | Description | Default |
| --- | --- | --- |
| Default chat model | Picked when starting a new chat. Selectable from your favorites only. | `anthropic/claude-haiku-4.5` on OpenRouter. |
| Title model | Cheap model that auto-titles a chat after the first exchange. By default mirrors the chat model — the row reads "Same as chat model" and offers **Customize…** if you want a different (usually cheaper) model. The mirror reverts automatically if you change the chat model. | Same as chat model. |
| Favorites | The short list each model picker shows first. Reorder with ↑ / ↓; remove with ×; add new ones from **Browse all models…**. Defaults rebind to the first favorite when you remove a favorite that was the active default. | Empty. Star models in **Browse all** to seed it. |

> [!tip]
> The model picker in the composer also surfaces favorites first, then any non-favorited models from the active endpoint. Curating favorites is the fastest way to slim the picker on a phone screen.

## Vault data

The single place Smart Aide stores its content in your vault.

| Setting | Description | Default |
| --- | --- | --- |
| Meta folder | Vault-relative path. Chats, skills, plugin internals, AGENTS.md, and memory all live under this folder (cross-tool standards at the meta root, plugin-only state under a `Smart Aide/` subfolder). Changing it does **not** move existing files — Smart Aide just starts reading and writing in the new location. | `Meta` |
| Reload skills, AGENTS.md & memory | Re-scans the skills directory and re-reads the AGENTS.md and memory files. Run this after editing any of them. (Edits made inside Obsidian also flow through automatically via the vault watcher; the button is the manual escape hatch.) | — |

The derived paths shown under the Meta folder field are not editable — they always follow the meta folder. Cross-tool standards (skills, AGENTS.md) sit directly under the meta folder so they can be symlinked from `~/.agents/`; plugin-only state nests under `Smart Aide/` so the file tree visibly distinguishes plugin storage from your own notes.

| Label | Path | Purpose |
| --- | --- | --- |
| Skills | `<meta>/skills/` | Skill files. One per skill, or a folder with a `SKILL.md`. Cross-tool standard. |
| Vault context | `<meta>/AGENTS.md` | Optional. Inner vault-context file, appended to the system prompt. Cross-tool standard. |
| Chats | `<meta>/Smart Aide/chats/` | One JSONL per chat. Pi session v3 format. |
| Memory | `<meta>/Smart Aide/memory.md` | Optional. Model-curated facts the user told the assistant across chats. Append-only via `save_memory`; prune by editing the file directly. |
| Plugin internals | `<meta>/Smart Aide/.internals/` | Cache / state. Off-limits to the read and write tools. |

> [!note]
> A second AGENTS.md can live at `<vault>/AGENTS.md` (the cross-tool standard location). Both are read if present; root first, then meta — see [AGENTS.md cross-tool standard](#agentsmd-cross-tool-standard).

## Skills

The Skills section in settings is mostly read-only — it shows the count of installed skills and the trust note. Skills themselves are markdown files you drop into `<meta>/skills/`. See the [Skills section in the README](../README.md#skills) for the format.

### Starter skills

Bundled skills you can install with one click. Each row shows the skill name, a short description, the recommended model, and a **Preview** disclosure with the full body.

| State | Row shows | Action |
| --- | --- | --- |
| Not installed | "Install" button | Writes the bundled skill to `<meta>/skills/<name>.md`. |
| Installed, unchanged | "Installed ✓" + Open link | Open jumps to the file. |
| Installed, customized | "Installed · customized" + Open link + "Reset sample" button | Reset overwrites your version; your edits are saved as `<name>.md.bak` first. |

> [!warning]
> Skill bodies are trusted prompt content — they can redirect the model, restrict tools, or carry hidden instructions. Review any skill you install from outside this vault before loading it.

## Safety

| Setting | Description | Default |
| --- | --- | --- |
| Auto-approve writes (dangerous) | Skips the diff approval card for `write_note` and `append_to_note`. Deletes still require explicit approval regardless. While on, a ⚠ chip appears in the chat's top bar so the state stays visible. | Off |
| Cost cap per turn (USD) | Block send when the next-turn projected cost exceeds this value. The check uses the same projection shown in the token chip popover (system + AGENTS.md + memory + skills + pinned + history + composer × the model's per-million pricing, plus a 500-token completion estimate), so what the chip shows is what trips the cap. Endpoints without pricing (LM Studio, custom gateways) never trip the cap. 0 = off. | 0 |

> [!warning]
> Auto-approve writes can drift your vault without you noticing — the model can rewrite, append to, or replace notes on its own. Turn it on only when you trust the current skill, model, and prompt. The ⚠ chip is your reminder.

### Sync-conflict banner

Smart Aide tracks the mtime of the active chat file at load and after every successful write. If Obsidian Sync (or another device, or a manual edit) modifies the file between turns, the next send shows a red banner above the composer instead of writing: "Another device updated this chat. Reload to see the latest, or start a new chat." Reload picks up the other device's writes; New chat starts fresh. The user's draft and pending images are preserved across the banner — the pre-flight check fires before any composer state is cleared.

This is a guard against the Obsidian Sync collision pattern other Obsidian AI plugins hit (Copilot #884, Smart Composer #479): two devices appending to the same chat file race and one device's turn disappears. The banner is the visible escape hatch.

## Advanced

| Setting | Description | Default |
| --- | --- | --- |
| System prompt | Sent at the start of every chat. Markdown-aware; AGENTS.md and the skill manifest are appended automatically — see the composed preview in the editor. The default prompt encodes response-shape rules (find vs. summarize vs. compare vs. write) and Obsidian markdown conventions; edit with care. | See `DEFAULT_SYSTEM_PROMPT` in `src/settings.ts`. |
| Anthropic prompt caching | On Anthropic-native endpoints only: marks the system prompt + tool definitions as ephemeral cache. ~90% off cached reads after the first turn. OpenAI-compat endpoints ignore this; Gemini-native uses implicit caching. | On |

## How Smart Aide uses Obsidian's configuration

Smart Aide reads several Obsidian-native settings rather than duplicating them. These are the non-obvious knobs — if you configure them in core Obsidian, Smart Aide picks them up at the next tool call, no reload required.

### Excluded files (search scope)

> [!note]
> **Settings → Files and links → Excluded files → Manage**

Folders or files in this list are skipped by `search_vault`, `list_recent`, and `get_backlinks`. The filter applies before BM25 ranking, so excluded notes can't crowd real results out of the top hits.

Entries accept four shapes — same as Obsidian core:

| Pattern | Effect |
| --- | --- |
| `Archive` | Folder by bare name, segment-bounded. Matches `Archive/foo.md` but not `Archived/foo.md`. |
| `Archive/` | Same as above, trailing slash makes the folder intent explicit. |
| `Archive/**` | Same as above, recursive glob form. |
| `/regex/` | Slash-wrapped JavaScript regex against the full path. |

**Override**: if you set `pathPrefix` on a search to a path under an excluded folder, the exclusion is bypassed for that call. Pointing AT an excluded folder means you mean it. In practice: "what's in my archive about X" → the model passes `pathPrefix: "Archive"` and Archive becomes visible for that query.

**Note**: Obsidian core treats excluded files as *down-ranked* in its own search, not hidden. Smart Aide treats them as a hard filter — the right behavior for BM25 retrieval where a single fat archived note can poison the ranking.

### Attachment folder (image attach)

> [!note]
> **Settings → Files and links → Default location for new attachments**

When you attach an image (paperclip, drag-drop, or paste), Smart Aide saves it via `app.fileManager.getAvailablePathForAttachment`. The image lands in whichever folder Obsidian itself uses for attachments — vault root, a fixed folder like `Attachments/`, or the same folder as the current note. Smart Aide doesn't override this.

The chat JSONL stores the path, not the bytes; bytes are re-read at send time and inlined to the model as base64.

**Vision-capability gating**: the paperclip disables (with an explanatory tooltip) when the active model's `/models` response says it doesn't accept image inputs — OpenRouter's `architecture.input_modalities`, OpenAI-compat `supports_vision`, etc. Anthropic + Gemini are hardcoded as vision-capable. Local servers that don't expose a vision flag are treated as allow (the provider rejects if it actually can't). Paste / drag-drop / vault-image drops all hit the same gate.

### AGENTS.md cross-tool standard

> [!note]
> **`<vault>/AGENTS.md`** — root location (other tools — Pi, Claude Code, Codex — look here too).
> **`<meta>/AGENTS.md`** — plugin-specific augmentation (defaults to `Meta/AGENTS.md`).

Both are optional. If both exist, they're concatenated root-first then meta, with file headers and a horizontal rule, so the model can tell them apart and the closer file's content wins on overlap. The combined body is appended to the system prompt between the base prompt and the skill manifest.

This is the [agents.md](https://agents.md/) cross-tool standard: drop a vault-context file at the root and it works with every agent tool that reads AGENTS.md, not just Smart Aide.

### Markdown-first

> [!note]
> Obsidian treats `.md` as the only first-class note type.

Every read and write tool (`read_note`, `write_note`, `append_to_note`, `delete_note`) requires a `.md` extension. Attachments (images, PDFs) flow through the attach path described above — not through the write tools. There is no setting to relax this; it mirrors Obsidian's own constraint.

### What Smart Aide does **not** read

Avoid surprise: these Obsidian core settings have no effect on Smart Aide.

- **Daily notes folder / Periodic Notes** — Smart Aide reads your notes via path-prefix and search, not via the daily-notes concept. The model figures out today's daily-note path from context (your AGENTS.md is the right place to document it).
- **Templates folder** — Smart Aide doesn't apply Obsidian templates. Skills are the equivalent: a skill body is template + instructions in one file.
- **Hidden files / dotfile handling** — Smart Aide blocks `.obsidian/` and the entire `<meta>/Smart Aide/` subtree (chats, memory.md, `.internals/`) directly through its own path guard, independent of Obsidian's hidden-files config. Cross-tool standards at the meta root (`<meta>/skills/`, `<meta>/AGENTS.md`) are *not* blocked — the model can still call `read_note` on a skill or AGENTS.md when the user references one.

## Where settings are stored

Two surfaces, two purposes.

| Surface | Contents | Synced across devices? |
| --- | --- | --- |
| `<vault>/.obsidian/plugins/smart-aide/data.json` | Vault-scoped settings only: `metaDir`, `systemPrompt`, `hasSeenMentionTip`. Per-device fields blanked on every write. | Yes — Obsidian Sync covers it (and Git, if you commit `.obsidian/`). |
| Browser `localStorage` (`vk:apikey:<endpointId>`) | Per-device API key store. Plaintext on disk in Obsidian's app sandbox — same as any browser localStorage. System-keychain integration is deferred. | No — localStorage is per-device by definition (desktop Electron, iOS WKWebView, Android WebView). |
| Browser `localStorage` (`vk:device-settings`) | Per-device settings blob: providers (endpoints), favorites, default chat / title model, auto-approve writes, cost cap, Anthropic prompt caching toggle. | No — same reason as keys: this is your local setup, not vault content. |

Per-device fields never come from `data.json` — only the localStorage device store. On a fresh device (or fresh install), the store is empty and you see the "add a provider" empty state.

### What syncs and what doesn't

| Lives in | Synced via Obsidian Sync? | Why |
| --- | --- | --- |
| Skills (`<meta>/skills/`) | Yes | Vault content — same skills should be available wherever you open the vault. |
| AGENTS.md, memory.md | Yes | Vault content — written by you / the model in this vault. |
| Chat history (`<meta>/Smart Aide/chats/`) | Yes | The conversation IS the vault content. Conflict banner guards mid-stream collisions. |
| `metaDir`, `systemPrompt`, `hasSeenMentionTip` | Yes | Vault-scoped configuration — describes the vault, not the device. |
| Providers (endpoints) | **No** | Different keys, different models per device. Mobile might use OpenRouter only; desktop might also have a local LM Studio. |
| Favorite models | **No** | Mobile favorites lean small / cheap; desktop favorites can include large-context models. |
| Default chat model, title model | **No** | Follow the per-device favorites. |
| Auto-approve writes | **No** | Safety setting — desktop's "yes I trust this" shouldn't flip on mobile, where you might fat-finger the chat. |
| Cost cap per turn | **No** | Different budget tolerances per device. |
| Anthropic prompt caching toggle | **No** | Tied to a specific endpoint setup; follows providers. |
| API keys | **No** | Per-device for security; this has been the case since 0.3.x. |

> [!note]
> After install on a second device, open **Settings → Providers** and re-add your providers (with keys) and favorites. This is deliberate — earlier designs that synced encrypted keys via `data.json` hit cross-device clobber bugs (Copilot #1350, Smart Composer #286). Now the same per-device isolation extends to provider list, favorites, defaults, and safety toggles so desktop ≠ mobile by default.

## Cross-references

- [Skills format](../README.md#skills) — frontmatter fields, user-invocable / `allowed-tools`, mobile gating.
- [Vault context (AGENTS.md)](../README.md#vault-context-agentsmd) — what to put in the file and starter outline.
- [Mobile constraints](../README.md#mobile) — what works on iPhone, what doesn't.
