import type { SampleSkill } from './types';

export const dailyNote: SampleSkill = {
	name: 'daily-note',
	shortDescription: "Create today's daily note and carry over yesterday's open tasks.",
	recommendedModel: 'Haiku 4.5 or Gemini Flash',
	body: `---
name: daily-note
description: 'Create the daily note for today and carry forward unchecked tasks from yesterday. Use when: (1) user says start today, todays daily note, or daily note, (2) user wants to begin a daily journal or log entry, (3) user mentions starting their day.'
---

# Daily note

Create or open today's daily note. Carry forward unchecked tasks from yesterday.

## Steps

1. Compute today's date as \`YYYY-MM-DD\`.
2. Target path: \`Daily/<today>.md\`. If it already exists, tell the user and stop.
3. Try \`read_note(path="Daily/<yesterday>.md")\`. If found, extract every unchecked \`- [ ]\` line.
4. \`write_note\` with the template below. Fill **Carried over** with those tasks (or \`(none)\` if none).

## Template

\`\`\`markdown
---
date: <YYYY-MM-DD>
tags: [daily]
---

# <YYYY-MM-DD>

## Notes

-

## Tasks

- [ ]

## Carried over

<unchecked tasks from yesterday, or "(none)">
\`\`\`

## Examples

- "start today's daily note" → read_note(Daily/<yesterday>.md) → write_note(Daily/<today>.md, …).
- "daily note for 2026-06-01" → write_note(Daily/2026-06-01.md, …) (skip carryover).

## Edge cases

- Yesterday's note doesn't exist: skip the carryover step; \`Carried over: (none)\`.
- Today's note already exists: do not overwrite. Tell the user the file is there.
- \`Daily/\` folder doesn't exist: \`write_note\` will create it.
`,
};
