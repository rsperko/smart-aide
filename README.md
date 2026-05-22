# Smart Aide

AI chat for your Obsidian vault — desktop and iPhone. Tool-mediated search and writes, citation cards that deep-link into your notes, auto-loading skills, branchable chat history.

## What it does

- **Conversational vault retrieval.** Ask "where did I write about X?" — Smart Aide searches your vault, reads the relevant section, and answers with a citation card that jumps to the exact heading on click.
- **No embeddings, no index.** Uses Obsidian's MetadataCache + fuzzy search + targeted reads. Works identically on iPhone and desktop; nothing to build, nothing to keep in sync.
- **Bring your own model, any provider.** Plug in any OpenAI-compatible endpoint — OpenRouter (default), OpenAI direct, Anthropic compat, local servers (LM Studio / Ollama / oMLX), or your own gateway. Pick the model per chat; the picker shows context window, cost ($/M tokens), and tool support inline.
- **Writes with diff approval.** `write_note`, `append_to_note`, `delete_note` all surface a diff card before they touch the vault. Approval state is persisted in the chat history.
- **Auto-loading skills.** Skill *descriptions* live in the system prompt; the model calls `load_skill(name)` to pull the body on demand. Skills directory is `~/.agents/skills/` on desktop (shared with Pi and Claude Code) or `<vault>/sys/skills/` on mobile.
- **Pi session format.** Chat history is JSONL in `<vault>/sys/chats/`, branch-aware (edit any user message to fork from there). Interops with the `session-manager` tooling.

## Install (BRAT)

1. Install **Obsidian42 - BRAT** from Community plugins → Browse.
2. BRAT settings → "Add Beta plugin" → paste `https://github.com/rsperko/smart-aide` → Add.
3. Settings → Community plugins → enable **Smart Aide**.
4. Open the Smart Aide settings tab and add your API key. The default endpoint is OpenRouter — one key gets you every major model. You can add OpenAI / Anthropic / local servers later.

Updates flow through BRAT's "Check for updates."

## Quick start

After install, open Smart Aide from the right sidebar (chat-bubble icon) or via the command palette (`Smart Aide: New chat`). Type a question about your vault and hit Enter. Click the chat title at the top to switch between conversations; long-press / right-click to rename.

## Mobile

Confirmed working on iPhone Obsidian:
- `fetch` + ReadableStream streaming
- `requestUrl` for blocking
- 3MB payloads on both transports

Skills must live under `<vault>/sys/skills/` on mobile (no Node API access). If you add a desktop-only feature in your own fork, set `isDesktopOnly: true` in `manifest.json`.

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
