# Smart Aide

AI chat for your Obsidian vault — desktop and iPhone. Tool-mediated search and writes, citation cards that deep-link into your notes, auto-loading skills, branchable chat history.

## What it does

- **Conversational vault retrieval.** Ask "where did I write about X?" — Smart Aide searches your vault, reads the relevant section, and answers with a citation card that jumps to the exact heading on click.
- **No embeddings, no index.** Uses Obsidian's MetadataCache + fuzzy search + targeted reads. Works identically on iPhone and desktop; nothing to build, nothing to keep in sync.
- **Bring your own model, any provider.** Plug in any OpenAI-compatible endpoint — OpenRouter (default), OpenAI direct, Anthropic compat, local servers (LM Studio / Ollama / oMLX), or your own gateway. Pick the model per chat; the picker shows context window, cost ($/M tokens), and tool support inline.
- **Writes with diff approval.** `write_note`, `append_to_note`, `delete_note` all surface a diff card before they touch the vault. Approval state is persisted in the chat history.
- **Skills.** Drop a markdown file into `<vault>/sys/skills/` (configurable) — its frontmatter `description` gets injected into the system prompt, and when a user request matches it the model calls `load_skill(name)` to pull the body on demand. Same folder on desktop and mobile. See the [Skills section below](#skills) for the format.
- **Pi session format.** Chat history is JSONL in `<vault>/sys/chats/`, branch-aware (edit any user message to fork from there). Interops with the `session-manager` tooling.

## Install (BRAT)

1. Install **Obsidian42 - BRAT** from Community plugins → Browse.
2. BRAT settings → "Add Beta plugin" → paste `https://github.com/rsperko/smart-aide` → Add.
3. Settings → Community plugins → enable **Smart Aide**.
4. Open the Smart Aide settings tab and add your API key. The default endpoint is OpenRouter — one key gets you every major model. You can add OpenAI / Anthropic / local servers later.

Updates flow through BRAT's "Check for updates."

## Quick start

After install, open Smart Aide from the right sidebar (chat-bubble icon) or via the command palette (`Smart Aide: New chat`). Type a question about your vault and hit Enter. Click the chat title at the top to switch between conversations; long-press / right-click to rename.

## Skills

Skills let you teach Smart Aide repeatable workflows without bloating every chat with their full instructions. Each skill is a markdown file. Its **description** gets injected into the system prompt (cheap, always-on); the model decides — based on the description matching the user's request — when to call `load_skill(name)` to pull the **body** into the conversation (the expensive part, on demand).

### Where they live

Default: `<vault>/sys/skills/`. Configurable in Settings → Skills.

The same folder is used on desktop and mobile — there is no `~/.agents/skills/` fallback. If you also use Pi or Claude Code with skills at `~/.agents/skills/`, symlink them yourself:

```bash
ln -s "$(pwd)/your-vault/sys/skills" ~/.agents/skills
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

The description is the **only triggering mechanism**, so write it well: include the user phrases that should activate it. The body is never seen by the model until `load_skill` fires.

### Reload

When you edit a skill file, run **Settings → Skills → Reload** (or restart the plugin). The registry caches the manifest at load time.

### Mobile note

iPhone Obsidian can read the skills folder but can't execute scripts referenced from a skill body. If your skill depends on running a Python script (like a template resolver) or anything that needs Node APIs, set `mobile: false` in the frontmatter.

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
