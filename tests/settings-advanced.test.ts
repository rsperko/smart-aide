import { describe, expect, it } from 'vitest';
import { composedSystemPromptPreview } from '../src/settings-advanced';

describe('composedSystemPromptPreview', () => {
	it('returns the base prompt alone when AGENTS.md and manifest are empty', () => {
		expect(composedSystemPromptPreview('base prompt', '', '')).toBe('base prompt');
	});

	it('appends manifest after the base when AGENTS.md is empty', () => {
		const out = composedSystemPromptPreview('BASE', '', 'MANIFEST');
		expect(out).toBe('BASE\n\nMANIFEST');
	});

	it('inserts AGENTS.md between base and manifest with the same framing the chat uses', () => {
		const out = composedSystemPromptPreview('BASE', 'AGENTS-BODY', 'MANIFEST');
		expect(out).toBe('BASE\n\nVault context (user-maintained):\n\nAGENTS-BODY\n\nMANIFEST');
	});

	it('omits the manifest section when no skills are installed', () => {
		const out = composedSystemPromptPreview('BASE', 'AGENTS-BODY', '');
		expect(out).toBe('BASE\n\nVault context (user-maintained):\n\nAGENTS-BODY');
	});

	it('preserves order: base → AGENTS → manifest (never reordered)', () => {
		const out = composedSystemPromptPreview('B', 'A', 'M');
		const indexBase = out.indexOf('B');
		const indexAgents = out.indexOf('A');
		const indexManifest = out.indexOf('M');
		expect(indexBase).toBeLessThan(indexAgents);
		expect(indexAgents).toBeLessThan(indexManifest);
	});
});
