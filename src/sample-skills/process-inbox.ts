import type { SampleSkill } from './types';

export const processInbox: SampleSkill = {
	name: 'process-inbox',
	shortDescription: 'Walk an inbox folder and triage each note into Projects, Areas, Resources, or Archive (PARA).',
	recommendedModel: 'Sonnet 4.6 or Gemini 2.5 Pro',
	body: `---
name: process-inbox
description: 'Walk an inbox folder and triage each note into Projects / Areas / Resources / Archive (PARA). Use when: (1) user says "process my inbox", "sort my inbox", or "clean up inbox", (2) user mentions PARA processing, (3) user wants to clear captured notes.'
---

# Process inbox

PARA-style triage of an inbox folder. One note at a time.

## Steps

1. \`list_recent(pathPrefix="Inbox", limit=20)\` to get the items.
2. If empty, tell the user the inbox is clear and stop.
3. For each item in order:
   a. \`read_note(path)\` to see what it is.
   b. Tell the user the path and a 1-2 line summary.
   c. Ask: **Project / Area / Resource / Archive / Delete / Skip?**
4. Apply the user's choice:
   - **Project** → \`write_note\` to \`Projects/<name>/<basename>\` (ask for project name if unclear).
   - **Area** → \`write_note\` to \`Areas/<area>/<basename>\` (ask for area).
   - **Resource** → \`write_note\` to \`Resources/<topic>/<basename>\` (ask for topic).
   - **Archive** → \`write_note\` to \`Archive/<basename>\`.
   - **Delete** → \`delete_note(path)\`.
   - **Skip** → leave it; move on.
5. When done, summarize: how many moved, deleted, skipped.

## Notes on workflow

- Move = write to new location, then delete original. Always confirm both steps with the user before the destructive part.
- If a note has many backlinks, warn the user before moving — links will break.

## Examples

- "process my inbox" → \`list_recent(Inbox)\` → walk each.
- "sort my inbox into PARA" → same workflow.

## Edge cases

- Inbox lives at a different path in this vault: ask the user where their inbox is, then use that prefix.
- User stops mid-way: do not auto-continue; ask whether to resume next session.
- Item is empty or junk: suggest Delete; still wait for the user's call.
`,
};
