import type { SampleSkill } from './types';

export const handwritingOcr: SampleSkill = {
	name: 'handwriting-ocr',
	shortDescription: 'Transcribe a photo of handwriting into plain text or a note.',
	recommendedModel: 'Gemini 3.5 Flash (Sonnet 4.6 on retry)',
	body: `---
name: handwriting-ocr
description: 'Transcribe handwriting from an attached photo into plain text or a note. Use when: (1) user attaches an image with the word "handwriting", (2) user says "transcribe this", "OCR this", or "what does this say", (3) image contains handwritten notes, a journal page, or a whiteboard.'
---

# Handwriting OCR

Transcribe the handwriting in the attached image, then optionally save it as a note.

## Steps

1. If no image is attached, ask the user to attach one. Do not proceed without an image.
2. Transcribe the handwriting verbatim. Preserve line breaks. Mark anything you cannot read clearly as \`[illegible]\`.
3. If the user asked to save it (or named a destination), call \`write_note\`. Default path: \`Inbox/handwritten-<YYYY-MM-DD>.md\`.
4. If they did not ask to save, return the transcription in your reply. They can ask you to save next.

## Save template

\`\`\`markdown
---
captured: <YYYY-MM-DD>
source: handwritten
---

<transcription>
\`\`\`

## Examples

- "transcribe this" → reply with the text only.
- "transcribe and save it" → write_note(path="Inbox/handwritten-<today>.md", content=<template>).
- "transcribe to Inbox/grocery.md" → write_note(path="Inbox/grocery.md", content=<template>).

## Edge cases

- Image is print, not handwriting: still transcribe; note that you saw print.
- Multiple pages in one image: separate them with \`---\`.
- Cursive you cannot read confidently: mark \`[illegible]\` and offer to retry with a stronger model.
`,
};
