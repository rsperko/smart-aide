# Settings reference

Settings live in **Settings → Community plugins → Smart Aide**. The tab is split into seven sections in fixed order: Overview, Providers, Chat models, Vault data, Skills, Safety, Advanced. This page covers every setting in each section, every default, and every behavior that depends on Obsidian core settings rather than Smart Aide's own.

If you only read one section: [How Smart Aide uses Obsidian's configuration](#how-smart-aide-uses-obsidians-configuration). Several behaviors are driven by Obsidian-native settings you may already have configured.

## Overview

A landing card with two parts:

- **Banner** — surfaces the one thing blocking you. "Add an API key" before any key is set; "<provider> didn't connect" if a connection test failed; "Pick favorite models" when no models are favorited yet.
- **Status rows** — one line each for Providers, Chat model, Favorites, Vault data, Skills, Safety. Each row's action button scrolls to the matching section.

No editable settings here. The Overview is read-only navigation.

## Providers

A provider is one OpenAI-compatible endpoint. You can configure as many as you want — each chat picks a model from one provider via a `ModelRef = { endpointId, slug }` pair, so the same model name on different providers stays unambiguous.

Click **Edit** on a row to open the endpoint editor (a sub-page, not a modal). Click **+ Add provider** at the bottom to pick a template (OpenRouter, OpenAI, Anthropic, Gemini, Custom).

### Endpoint editor

| Setting | Description | Default |
| --- | --- | --- |
| Name | Display label in pickers and the model chip. | Template-derived (e.g. "OpenRouter"). |
| Base URL | Root URL Smart Aide calls. For OpenAI-compat the path appended is `/chat/completions`; for native Anthropic `/v1/messages`; for native Gemini `/v1beta/models/*:streamGenerateContent`. | Template-derived. |
| API key | Per-device secret. Stored outside `data.json` so synced vaults don't ship keys. See [Where settings are stored](#where-settings-are-stored). | Empty. |
| Protocol | `openai-compat`, `anthropic`, or `gemini`. Selected by the template at creation; OpenRouter / OpenAI direct / local servers all use `openai-compat`. | `openai-compat` |
| Test connection | One-shot probe of `GET {baseURL}/models` (or the native equivalent). Result persists with a timestamp; visible on the provider row. | — |
| Refresh models | Re-runs discovery. Auto-runs 1.5s after a key is pasted. | — |
| Manual model list (advanced) | Fallback when discovery is empty or the provider doesn't expose `/models`. One slug per line. | Empty. |
| Custom headers (advanced) | Extra HTTP headers sent on every request. JSON object. Used for self-hosted gateways that require auth headers beyond `Authorization`. | Empty. |
| Delete | Two-click confirm. Disabled when there's only one endpoint. | — |

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
| Meta folder | Vault-relative path. Chats, skills, plugin internals, and the optional vault-context `AGENTS.md` all live under this folder. Changing it does **not** move existing files — Smart Aide just starts reading and writing in the new location. | `Meta` |
| Reload skills & AGENTS.md | Re-scans the skills directory and re-reads the AGENTS.md files. Run this after editing a skill file or AGENTS.md. | — |

The four derived paths shown under the Meta folder field are not editable — they always follow the meta folder:

| Label | Path | Purpose |
| --- | --- | --- |
| Chats | `<meta>/chats/` | One JSONL per chat. Pi session v3 format. |
| Skills | `<meta>/skills/` | Skill files. One per skill, or a folder with a `SKILL.md`. |
| Plugin internals | `<meta>/.smart-aide/` | Cache / state. Off-limits to the read and write tools. |
| Vault context | `<meta>/AGENTS.md` | Optional. Inner vault-context file, appended to the system prompt. |

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

> [!warning]
> Auto-approve writes can drift your vault without you noticing — the model can rewrite, append to, or replace notes on its own. Turn it on only when you trust the current skill, model, and prompt. The ⚠ chip is your reminder.

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
- **Hidden files / dotfile handling** — Smart Aide blocks `.obsidian/`, `<meta>/.smart-aide/`, and `<meta>/chats/` directly through its own path guard, independent of Obsidian's hidden-files config.

## Where settings are stored

Two files, two purposes.

| File | Contents | Synced via Obsidian Sync? |
| --- | --- | --- |
| `<vault>/.obsidian/plugins/smart-aide/data.json` | All settings *except* API keys. Endpoints with `apiKey: ""` blanked on write. | Yes. |
| `<vault>/.obsidian/plugins/smart-aide/api-keys.json` | Per-device API key store. Plaintext today; system-keychain integration is deferred. | No — `.obsidian/` sync filters this out per-device on purpose. |

On first run after upgrade from a legacy single-key install, keys present in `data.json` are migrated into the key store and the `data.json` copy is blanked on the next save.

> [!warning]
> If you share a vault via Git, gitignore `.obsidian/plugins/smart-aide/api-keys.json`. The plugin keeps it per-device, but Git doesn't know that.

## Cross-references

- [Skills format](../README.md#skills) — frontmatter fields, user-invocable / `allowed-tools`, mobile gating.
- [Vault context (AGENTS.md)](../README.md#vault-context-agentsmd) — what to put in the file and starter outline.
- [Mobile constraints](../README.md#mobile) — what works on iPhone, what doesn't.
