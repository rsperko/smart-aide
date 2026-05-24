import type { SampleSkill } from './types';

export const weeklyReview: SampleSkill = {
	name: 'weekly-review',
	shortDescription: 'Read the past week of daily notes and produce a themes + completed + open + dormant summary.',
	recommendedModel: 'Sonnet 4.6 or Gemini 2.5 Pro',
	body: `---
name: weekly-review
description: 'Summarize the past week from daily notes — themes, completed tasks, open items, dormant projects. Use when: (1) user says "weekly review", "review my week", or "what did I do this week", (2) user wants a retrospective of recent activity, (3) user mentions a weekly retro.'
---

# Weekly review

Read the past 7 days of daily notes and write a weekly summary.

## Steps

1. Identify the ISO week (or use the date range the user gave). Compute the 7 dates.
2. For each date, try \`read_note(path="Daily/<date>.md")\`. Some may be missing — skip those.
3. From the loaded notes, extract:
   - Completed tasks (\`- [x] …\`)
   - Open tasks (\`- [ ] …\`)
   - Notable headings + 1-line snippets
4. Synthesize themes — 2-4 sentences. What did the week revolve around?
5. \`list_recent(sinceDays=14, pathPrefix="Projects")\` to find projects that were NOT touched this week. Flag them as **dormant**.
6. \`write_note\` to \`Weekly/<YYYY>-W<WW>.md\` using the template.

## Template

\`\`\`markdown
---
week: <YYYY>-W<WW>
range: <YYYY-MM-DD> to <YYYY-MM-DD>
tags: [weekly-review]
---

# Week <YYYY>-W<WW>

## Themes

<2-4 sentences>

## Completed

- [x] …

## Open

- [ ] …

## Dormant projects

- [[Project A]] (last touched <date>)

## Notes worth revisiting

- [[Daily/<date>]] — <snippet>
\`\`\`

## Examples

- "weekly review" → 7 dailies for this ISO week → \`write_note(Weekly/2026-W21.md, …)\`.
- "what did I do last week" → previous ISO week range → same workflow.

## Edge cases

- 0 daily notes in the range: tell the user; do not fabricate a summary.
- Daily notes live somewhere else in this vault (e.g. \`Journal/\`): use whatever folder has notes for the dates. Ask if unclear.
- User stopped logging mid-week: summarize what's there; mention the gap explicitly.
`,
};
