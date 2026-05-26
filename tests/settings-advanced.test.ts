import { describe, expect, it } from 'vitest';
import { composedSystemPromptPreview } from '../src/settings-advanced';

describe('composedSystemPromptPreview', () => {
	it('returns the base prompt alone when every appended section is empty', () => {
		expect(composedSystemPromptPreview('base prompt', '', '', '')).toBe('base prompt');
	});

	it('appends manifest after the base when AGENTS.md and memory are empty', () => {
		const out = composedSystemPromptPreview('BASE', '', '', 'MANIFEST');
		expect(out).toBe('BASE\n\nMANIFEST');
	});

	it('inserts AGENTS.md between base and manifest with the chat framing', () => {
		const out = composedSystemPromptPreview('BASE', 'AGENTS-BODY', '', 'MANIFEST');
		expect(out).toBe('BASE\n\nVault context (user-maintained):\n\nAGENTS-BODY\n\nMANIFEST');
	});

	it('inserts memory after AGENTS.md and before the manifest', () => {
		const out = composedSystemPromptPreview('BASE', 'AGENTS-BODY', 'MEM-BODY', 'MANIFEST');
		expect(out).toContain('Vault context (user-maintained):\n\nAGENTS-BODY');
		expect(out).toContain('Persistent memory (your prior saves');
		expect(out).toContain('MEM-BODY');
		const indexAgents = out.indexOf('AGENTS-BODY');
		const indexMem = out.indexOf('MEM-BODY');
		const indexManifest = out.indexOf('MANIFEST');
		expect(indexAgents).toBeLessThan(indexMem);
		expect(indexMem).toBeLessThan(indexManifest);
	});

	it('drops AGENTS.md framing when only memory is loaded', () => {
		const out = composedSystemPromptPreview('BASE', '', 'MEM', 'MANIFEST');
		expect(out).not.toContain('Vault context');
		expect(out).toContain('Persistent memory');
		expect(out).toContain('MEM');
		expect(out).toContain('MANIFEST');
	});

	it('omits the manifest section when no skills are installed', () => {
		const out = composedSystemPromptPreview('BASE', 'AGENTS', 'MEM', '');
		expect(out).toBe('BASE\n\nVault context (user-maintained):\n\nAGENTS\n\nPersistent memory (your prior saves — call save_memory to extend):\n\nMEM');
	});
});
