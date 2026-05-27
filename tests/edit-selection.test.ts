import { describe, expect, it } from 'vitest';
import {
	buildEditPrompt,
	capDocumentForWire,
	extractRewrite,
	injectSelectionMarkers,
	type EditRequestInput,
} from '../src/edit-selection';

const SEL_OPEN = '<<<SMART_AIDE_SELECTION>>>';
const SEL_CLOSE = '<<<END_SMART_AIDE_SELECTION>>>';

function makeInput(over: Partial<EditRequestInput> = {}): EditRequestInput {
	return {
		selection: 'foo',
		instruction: 'rewrite',
		documentText: 'foo',
		from: { line: 0, ch: 0 },
		to: { line: 0, ch: 3 },
		...over,
	};
}

describe('injectSelectionMarkers', () => {
	it('brackets a single-line selection at the correct character positions', () => {
		const doc = 'alpha beta gamma';
		const out = injectSelectionMarkers(doc, { line: 0, ch: 6 }, { line: 0, ch: 10 });
		expect(out).toBe(`alpha ${SEL_OPEN}beta${SEL_CLOSE} gamma`);
	});

	it('brackets a multi-line selection', () => {
		const doc = 'line zero\nline one\nline two';
		const out = injectSelectionMarkers(doc, { line: 0, ch: 5 }, { line: 1, ch: 4 });
		expect(out).toBe(`line ${SEL_OPEN}zero\nline${SEL_CLOSE} one\nline two`);
	});

	it('brackets a selection that spans the full document', () => {
		const doc = 'whole doc';
		const out = injectSelectionMarkers(doc, { line: 0, ch: 0 }, { line: 0, ch: 9 });
		expect(out).toBe(`${SEL_OPEN}whole doc${SEL_CLOSE}`);
	});

	it('clamps an out-of-range ch to end of line', () => {
		const doc = 'short';
		// ch beyond line length should clamp, not throw.
		const out = injectSelectionMarkers(doc, { line: 0, ch: 0 }, { line: 0, ch: 999 });
		expect(out).toBe(`${SEL_OPEN}short${SEL_CLOSE}`);
	});
});

describe('capDocumentForWire', () => {
	it('returns the document unchanged when under the cap', () => {
		const small = `${SEL_OPEN}sel${SEL_CLOSE}\n` + 'x'.repeat(1000);
		expect(capDocumentForWire(small)).toBe(small);
	});

	it('trims around the selection markers when over the cap', () => {
		const before = 'b'.repeat(50_000);
		const after = 'a'.repeat(50_000);
		const huge = `${before}${SEL_OPEN}sel${SEL_CLOSE}${after}`;
		const out = capDocumentForWire(huge);
		// Markers still present.
		expect(out).toContain(SEL_OPEN);
		expect(out).toContain(SEL_CLOSE);
		expect(out).toContain('sel');
		// Truncation markers added on both sides.
		expect(out).toContain('document truncated above');
		expect(out).toContain('document truncated below');
		// Net length is much smaller than the original.
		expect(out.length).toBeLessThan(huge.length / 2);
	});

	it('does not add the "above" marker when selection is near the start', () => {
		const after = 'a'.repeat(100_000);
		const huge = `${SEL_OPEN}sel${SEL_CLOSE}${after}`;
		const out = capDocumentForWire(huge);
		expect(out.startsWith(SEL_OPEN)).toBe(true);
		expect(out).not.toContain('document truncated above');
		expect(out).toContain('document truncated below');
	});
});

describe('buildEditPrompt', () => {
	it('pins down the system prompt invariants', () => {
		const { system } = buildEditPrompt(makeInput());
		expect(system).toMatch(/Return ONLY the new text/);
		expect(system).toMatch(/Do not return the markers/);
		expect(system).toMatch(/Use the surrounding document for context/);
		expect(system).toContain(SEL_OPEN);
		expect(system).toContain(SEL_CLOSE);
	});

	it('embeds the document with selection markers in the user message', () => {
		const out = buildEditPrompt(
			makeInput({
				documentText: 'alpha beta gamma',
				from: { line: 0, ch: 6 },
				to: { line: 0, ch: 10 },
			}),
		);
		expect(out.user).toContain(`alpha ${SEL_OPEN}beta${SEL_CLOSE} gamma`);
		expect(out.user).toContain('Instruction: rewrite');
	});

	it('omits the vault-context section when AGENTS.md is empty', () => {
		const out = buildEditPrompt(makeInput());
		expect(out.user).not.toMatch(/Vault context/);
		expect(out.user).not.toMatch(/Persistent memory/);
	});

	it('includes Vault context when AGENTS.md is non-empty', () => {
		const out = buildEditPrompt(makeInput({ agentsBody: 'Use British spellings.' }));
		expect(out.user).toContain('Vault context (user-maintained):');
		expect(out.user).toContain('Use British spellings.');
	});

	it('includes Persistent memory when memory.md is non-empty', () => {
		const out = buildEditPrompt(makeInput({ memoryBody: '- 2026-05-26: Likes Go-style braces.' }));
		expect(out.user).toContain('Persistent memory:');
		expect(out.user).toContain('Go-style braces');
	});

	it('orders Vault context → Memory → Document → Instruction', () => {
		const out = buildEditPrompt(
			makeInput({
				agentsBody: 'AGENTS_BODY',
				memoryBody: 'MEM_BODY',
				documentText: 'DOC_BODY',
				from: { line: 0, ch: 0 },
				to: { line: 0, ch: 8 },
			}),
		);
		const u = out.user;
		expect(u.indexOf('AGENTS_BODY')).toBeLessThan(u.indexOf('MEM_BODY'));
		expect(u.indexOf('MEM_BODY')).toBeLessThan(u.indexOf('DOC_BODY'));
		expect(u.indexOf('DOC_BODY')).toBeLessThan(u.indexOf('Instruction:'));
	});

	it('treats whitespace-only AGENTS/memory as empty', () => {
		const out = buildEditPrompt(
			makeInput({
				agentsBody: '   \n\n',
				memoryBody: '\n',
			}),
		);
		expect(out.user).not.toMatch(/Vault context/);
		expect(out.user).not.toMatch(/Persistent memory/);
	});
});

describe('extractRewrite', () => {
	it('returns the text unchanged when no code fence wraps it', () => {
		expect(extractRewrite('hello world')).toBe('hello world');
		expect(extractRewrite('  trimmed  ')).toBe('trimmed');
	});

	it('strips a bare ``` wrapping fence', () => {
		expect(extractRewrite('```\nrewritten content\n```')).toBe('rewritten content');
	});

	it('strips a language-tagged wrapping fence', () => {
		expect(extractRewrite('```markdown\n# Heading\n\nBody.\n```')).toBe('# Heading\n\nBody.');
	});

	it('preserves inner code-fence-like content', () => {
		const text = '```\nbefore\n\n```js\nconsole.log("x")\n```\n\nafter\n```';
		const out = extractRewrite(text);
		expect(out).toContain('before');
		expect(out).toContain('console.log("x")');
		expect(out).toContain('after');
		expect(out).toContain('```js');
	});

	it('returns empty string for empty input', () => {
		expect(extractRewrite('')).toBe('');
		expect(extractRewrite('   ')).toBe('');
	});
});
