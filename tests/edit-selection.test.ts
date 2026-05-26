import { describe, expect, it } from 'vitest';
import { buildEditPrompt, extractRewrite } from '../src/edit-selection';

describe('buildEditPrompt', () => {
	it('returns a system message that pins down "no preamble, no code fence"', () => {
		const { system } = buildEditPrompt('foo', 'bar');
		expect(system).toMatch(/return ONLY the rewritten text/i);
		expect(system).toMatch(/no preamble/i);
		expect(system).toMatch(/no surrounding code fence/i);
		expect(system).toMatch(/preserve formatting/i);
	});

	it('embeds the selection and the instruction in the user message', () => {
		const { user } = buildEditPrompt('the quick brown fox', 'make it about a turtle');
		expect(user).toContain('Selection:');
		expect(user).toContain('the quick brown fox');
		expect(user).toContain('Instruction: make it about a turtle');
	});

	it('uses delimiters that survive ambiguous selection content', () => {
		// A selection that contains "Instruction:" or "Selection:" shouldn't
		// confuse the model — the SELECTION delimiter brackets the content.
		const { user } = buildEditPrompt('Instruction: confuse the parser', 'rewrite');
		expect(user).toContain('<<<SELECTION');
		expect(user).toContain('SELECTION');
		// The literal selection content still appears inside the delimiters.
		const open = user.indexOf('<<<SELECTION');
		const close = user.indexOf('\nSELECTION');
		expect(open).toBeLessThan(close);
		expect(user.slice(open, close)).toContain('Instruction: confuse the parser');
	});
});

describe('extractRewrite', () => {
	it('returns the text unchanged when no code fence wraps it', () => {
		expect(extractRewrite('hello world')).toBe('hello world');
		expect(extractRewrite('  trimmed  ')).toBe('trimmed');
	});

	it('strips a bare ``` wrapping fence', () => {
		const wrapped = '```\nrewritten content\n```';
		expect(extractRewrite(wrapped)).toBe('rewritten content');
	});

	it('strips a language-tagged wrapping fence', () => {
		const wrapped = '```markdown\n# Heading\n\nBody.\n```';
		expect(extractRewrite(wrapped)).toBe('# Heading\n\nBody.');
	});

	it('preserves inner code-fence-like content', () => {
		// The model might legitimately include a code block inside its rewrite.
		// Only the outermost wrapping fence is stripped.
		const text = '```\nbefore\n\n```js\nconsole.log("x")\n```\n\nafter\n```';
		const out = extractRewrite(text);
		expect(out).toContain('before');
		expect(out).toContain('console.log("x")');
		expect(out).toContain('after');
		// The inner ```js…``` block is preserved.
		expect(out).toContain('```js');
	});

	it('does not strip when there is trailing content after the closing fence', () => {
		// "Here is your edit: ```...``` Hope this helps!" — the model didn't
		// follow instructions. We leave the whole string alone rather than
		// silently dropping the trailing chatter (which would discard the closing
		// boundary marker the model may have intended).
		const text = '```\ncontent\n```\nHope this helps!';
		expect(extractRewrite(text)).toBe(text.trim());
	});

	it('throws nothing on empty input — returns empty string', () => {
		expect(extractRewrite('')).toBe('');
		expect(extractRewrite('   ')).toBe('');
	});

	it('handles fences with trailing whitespace on the opening line', () => {
		const text = '```ts   \nconst x = 1;\n```';
		expect(extractRewrite(text)).toBe('const x = 1;');
	});
});
