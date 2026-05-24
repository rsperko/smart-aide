import type { SampleSkill } from './types';

export const meetingNotes: SampleSkill = {
	name: 'meeting-notes',
	shortDescription: 'Start a new meeting note with frontmatter and the standard sections.',
	recommendedModel: 'Haiku 4.5 or Gemini Flash',
	body: `---
name: meeting-notes
description: 'Create a new meeting note with frontmatter and a standard section skeleton ready to fill in. Use when: (1) user says "start meeting notes", "new meeting", or "I have a meeting", (2) user is preparing to take notes during a meeting, (3) user names a meeting title or attendees.'
---

# Meeting notes

Create a new meeting note ready for the user to fill in.

## Steps

1. Confirm or ask for: meeting title and attendees. Use today's date unless the user gives one.
2. Build the destination path: \`Meetings/<YYYY-MM-DD>-<kebab-title>.md\`.
3. Call \`write_note\` with the template below.
4. Tell the user the file is ready. Remind them to capture action items in the right section.

## Template

\`\`\`markdown
---
date: <YYYY-MM-DD>
type: meeting
attendees: [<comma-separated>]
tags: [meeting]
---

# <Title>

## Agenda

-

## Discussion

-

## Decisions

-

## Action items

- [ ]

## Open questions

-
\`\`\`

## Examples

- "start meeting notes for Q3 planning with Alice and Bob"
  → write_note(path="Meetings/<today>-q3-planning.md", content=<filled template>).
- "new meeting: weekly 1:1 with Manager"
  → write_note(path="Meetings/<today>-weekly-1-1-manager.md", content=<filled template>).

## Edge cases

- No title given: ask before writing.
- Title contains slashes or odd chars: lowercase, replace non-alphanumerics with hyphens.
- File already exists for today's title: ask whether to overwrite or use a \`-2\` suffix.
`,
};
