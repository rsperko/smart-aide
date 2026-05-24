import type { SampleSkill } from './types';

export const mocBuilder: SampleSkill = {
	name: 'moc-builder',
	shortDescription: 'Build a new Map of Content (MOC) for a topic, or refresh an existing one.',
	recommendedModel: 'Sonnet 4.6 (with caching) or Gemini 3.1 Pro',
	body: `---
name: moc-builder
description: 'Build or refresh a Map of Content (MOC) — a curated hub note linking to all related notes on a topic. Use when: (1) user says "create a MOC for X", "build a map of content", or "MOC for <topic>", (2) user wants to refresh an existing MOC, (3) user mentions Zettelkasten / MOC workflows.'
user-invocable: true
allowed-tools: [search_vault, get_backlinks, read_note, write_note]
---

# MOC builder

Build (CREATE) or update (REFRESH) a Map of Content note that curates links to every note about a topic.

## Pick the mode

- "create a MOC for <topic>" → **CREATE**.
- "refresh the MOC at <path>" or "update <MOC path>" → **REFRESH**.

## CREATE mode

1. Confirm: topic name. Default destination: \`Areas/MOC <topic>.md\` (ask if unclear).
2. Issue 2-3 parallel \`search_vault\` calls — the topic plus 1-2 synonyms. Set \`deepSearch=true\` on a retry if the first attempt returns few hits.
3. Take the top ~10 hits, run \`get_backlinks\` on each to discover adjacent notes.
4. Group notes into sub-topics by inferred theme.
5. Draft the MOC using the template below; pick the most-linked + most-recent notes per section, keep total links under ~30.
6. \`write_note\` to the destination and tell the user what you built.

## REFRESH mode

1. \`read_note(<moc-path>)\` to load the existing MOC.
2. \`list_recent(sinceDays=30)\` and a couple of \`search_vault\` calls for the topic.
3. Find notes that are NOT already linked from the MOC.
4. Propose which section each new note belongs in. Confirm with the user.
5. \`write_note\` the updated MOC.

## Template

\`\`\`markdown
---
created: <YYYY-MM-DD>
tags: [moc]
---

# MOC <Topic>

## Overview

<one paragraph describing the domain>

## Key concepts

- [[Note A]]
- [[Note B]]

## <Sub-topic 1>

- [[…]]

## <Sub-topic 2>

- [[…]]

## Related MOCs

- [[…]]
\`\`\`

## Examples

- "create a MOC for machine learning" → parallel \`search_vault\` for "machine learning" / "ML" / "AI" → \`get_backlinks\` on top hits → draft → \`write_note(Areas/MOC machine learning.md)\`.
- "refresh the MOC at Areas/MOC Recipes.md" → \`read_note\` → find recent unlinked notes → propose insertions.

## Edge cases

- 0 search hits: ask the user to refine the topic, or offer to write an empty MOC scaffold they can fill in manually.
- MOC destination already exists in CREATE mode: ask before overwriting.
- 50+ candidate notes: trim to ~30. Prefer most-backlinked + most-recently-modified.
`,
};
