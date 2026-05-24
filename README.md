# Smart Aide

AI chat for your Obsidian vault — desktop and iPhone. Tool-mediated search and writes, citation cards that deep-link into your notes, auto-loading skills, branchable chat history.

## What it does

- **Conversational vault retrieval.** Ask "where did I write about X?" — Smart Aide searches your vault, reads the relevant section, and answers with a citation card that jumps to the exact heading on click.
- **No embeddings, no index.** Uses Obsidian's MetadataCache + fuzzy search + targeted reads. Works identically on iPhone and desktop; nothing to build, nothing to keep in sync.
- **Bring your own model, any provider.** Plug in any OpenAI-compatible endpoint — OpenRouter (default), OpenAI direct, Anthropic compat, local servers (LM Studio / Ollama / oMLX), or your own gateway. Pick the model per chat; the picker shows context window, cost ($/M tokens), and tool support inline.
- **Writes with diff approval.** `write_note`, `append_to_note`, `delete_note` surface a diff card before they touch the vault. Approval state is persisted in the chat history. Optional **dangerous mode** in settings auto-approves writes (deletes always still confirm).
- **Edit and fork.** Tap (or hover) the pencil on any of your past messages to edit it. Send forks the conversation from that point — the branch and everything downstream are hidden, the new turn becomes the leaf. The original branch stays in the JSONL file.
- **Image attach.** Paperclip in the composer toolbar (file picker), camera button on mobile, clipboard paste, or drag-drop from Finder / vault attachments. Images are saved into Obsidian's configured attachment folder and inlined to the model as base64 multi-part content; the chat JSONL only stores the path, so history stays small. JPEG / PNG / GIF / WebP.
- **Skills.** Drop a markdown file into `<vault>/Meta/skills/` (configurable) — its frontmatter `description` gets injected into the system prompt, and when a user request matches it the model calls `load_skill(name)` to pull the body on demand. Skills can also be **user-invocable**: add `user-invocable: true` to the frontmatter and type `/<name>` in the composer to summon it directly. Same folder on desktop and mobile. See the [Skills section below](#skills) for the format.
- **Vault context via AGENTS.md.** Drop an `AGENTS.md` at `<vault>/Meta/AGENTS.md` to tell the agent about your vault — folder layout, tag conventions, projects, paths to leave alone. The body is appended to the system prompt. Standard cross-tool format ([agents.md](https://agents.md/)) so the same file works with other agent tools.
- **Pi session format.** Chat history is JSONL in `<vault>/Meta/chats/`, branch-aware via `parentId`. Interops with the `session-manager` tooling.

## Install (BRAT)

1. Install **Obsidian42 - BRAT** from Community plugins → Browse.
2. BRAT settings → "Add Beta plugin" → paste `https://github.com/rsperko/smart-aide` → Add.
3. Settings → Community plugins → enable **Smart Aide**.
4. Open the Smart Aide settings tab and add your API key. The default endpoint is OpenRouter — one key gets you every major model. You can add OpenAI / Anthropic / local servers later.

Updates flow through BRAT's "Check for updates."

## Quick start

After install, open Smart Aide from the right sidebar (chat-bubble icon) or via the command palette (`Smart Aide: New chat`). Type a question about your vault and hit Enter. Click the chat title at the top to switch between conversations; long-press / right-click to rename. The picker shows a small × on each row for delete (two-click confirm to prevent oops).

## Skills

Skills let you teach Smart Aide repeatable workflows without bloating every chat with their full instructions. Each skill is a markdown file. Its **description** gets injected into the system prompt (cheap, always-on); the model decides — based on the description matching the user's request — when to call `load_skill(name)` to pull the **body** into the conversation (the expensive part, on demand).

### Where they live

Default: `<vault>/Meta/skills/`. The parent folder (`Meta`) is configurable in Settings → Storage; a common alternative is `sys`. Skills and chats live under the same meta folder.

The same folder is used on desktop and mobile — there is no `~/.agents/skills/` fallback. If you also use Pi or Claude Code with skills at `~/.agents/skills/`, symlink them yourself:

```bash
ln -s "$(pwd)/your-vault/Meta/skills" ~/.agents/skills
# or in the other direction
```

### File format

Two layouts work:

- A single file: `<skills-dir>/<name>.md`
- A directory with a `SKILL.md` inside: `<skills-dir>/<name>/SKILL.md` (use this when the skill has supporting scripts, templates, or references)

Both follow the [Agent Skills standard](https://agentskills.io/specification):

```markdown
---
name: meeting-notes
description: Draft a meeting-recap note. Use when the user mentions a meeting, standup, 1:1, or asks to "write up" a call. Format follows the team's recap template.
mobile: true
---

# meeting-notes

(body — instructions the model follows once this skill is loaded)

## Output format

1. **Attendees** — names from the user's mention or ask
2. **Decisions** — bullet list of clear decisions made
3. **Action items** — `- [ ] @person task` lines
4. **Notes** — anything else worth keeping

## Place the file

- Default: `Daily/YYYY-MM-DD - Meeting recap.md`
- Use `write_note` and let the user approve.
```

Required frontmatter:
- `name` — lowercase, hyphens only, 64 chars max
- `description` — what the skill does + when to use it (max 1024 chars)

Optional:
- `mobile: false` — hide the skill on iPhone (skip it for skills that depend on desktop-only scripts or filesystem paths)
- `user-invocable: true` — surfaces the skill as `/<name>` in the composer (see below)
- `allowed-tools: [read_note, write_note]` — restricts which tools the model can call while this skill is active. Pairs with `user-invocable`; ignored when the skill is loaded via `load_skill`. Accepts flow `[a, b]` or block `\n  - a\n  - b` styles.

The description is the **only triggering mechanism** for model-invoked skills, so write it well: include the user phrases that should activate it. The body is never seen by the model until `load_skill` fires.

### User-invocable skills (slash commands)

Skills with `user-invocable: true` can be summoned directly from the composer by typing `/<name>`. In an empty composer, typing `/` opens a fuzzy picker over all user-invocable skills. Selecting one fills the composer with `/<name> `; type your prompt after and send. The skill body is injected as context for that turn; `allowed-tools` (when set) scopes the tool surface for the whole assistant loop that follows. The override applies only to the burst the slash triggered — the next regular user message reverts to the full tool set.

Use `user-invocable` when:
- You want the workflow available on demand without relying on the model recognizing a trigger phrase
- You want a narrower tool surface than the global default (e.g. an editor skill that can't `delete_note`)
- You want to teach the trust frame — `/weekly` signals intent the way `/help` does in chat tools

Skip it when the skill is naturally triggered by phrasing (the model's matcher catches it via the description) and you don't need tool scoping.

Example:

```markdown
---
name: daily-note
description: Create today's daily note and carry forward unchecked tasks. Use when…
user-invocable: true
allowed-tools: [read_note, write_note]
---

# Daily note
…
```

Now `/daily` (or `/daily-note`) in the composer runs the workflow with only `read_note` + `write_note` available.

### Reload

When you edit a skill file, run **Settings → Skills → Reload** (or restart the plugin). The registry caches the manifest at load time.

### Mobile note

iPhone Obsidian can read the skills folder but can't execute scripts referenced from a skill body. If your skill depends on running a Python script (like a template resolver) or anything that needs Node APIs, set `mobile: false` in the frontmatter.

## Vault context (AGENTS.md)

If a file exists at `<vault>/Meta/AGENTS.md` (or wherever your meta folder is configured), its contents are appended to the system prompt as vault context. This is the [AGENTS.md cross-tool standard](https://agents.md/) repurposed for a vault: tell the agent about your folder layout, tag conventions, ongoing projects, and paths you don't want it writing into.

Plain Markdown with any headings you like. A useful starter outline:

```markdown
# Vault context

## Layout
- `Daily/` — daily notes, one per day
- `Projects/<name>/` — active projects
- `Archive/` — anything I'm not touching

## Tags
- `#book` — books I've read or want to read
- `#idea` — half-baked thoughts to revisit

## Conventions
- Headings in sentence case
- Wikilinks for cross-references, no inline URLs

## Avoid
- Don't write into `Archive/`
- Don't modify daily notes from prior days
```

Edits picked up via **Settings → Skills & AGENTS.md → Reload** (or restart the plugin). Note: this is the *vault* AGENTS.md, not a code-repo AGENTS.md — if you symlink from a project repo, you'll get crossed wires.

## Mobile

Confirmed working on iPhone Obsidian:
- `fetch` + ReadableStream streaming
- `requestUrl` for blocking
- 3MB payloads on both transports

The plugin sets `isDesktopOnly: false`; if you add a desktop-only feature in your own fork, flip it.

## Local development

```bash
npm install
npm run dev    # watch — rebuilds on save
npm run build  # one-shot production build
```

Symlink the repo into your vault for live iteration:

```bash
ln -s "$(pwd)" "$(your-vault)/.obsidian/plugins/smart-aide"
```

`data.json` (which holds your API key) is gitignored — verify before any commit.

## License

MIT.
