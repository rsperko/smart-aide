import { describe, expect, it } from 'vitest';
import { derivedPathLabels } from '../src/settings-vault-data';

describe('derivedPathLabels', () => {
	it('keeps cross-tool standards (skills, AGENTS.md) at metaDir root', () => {
		const out = derivedPathLabels('Meta');
		expect(out.skills).toBe('Meta/skills');
		expect(out.agentsMd).toBe('Meta/AGENTS.md');
	});

	it('nests plugin-only state under the Smart Aide subfolder', () => {
		const out = derivedPathLabels('Meta');
		expect(out.chats).toBe('Meta/Smart Aide/chats');
		expect(out.internals).toBe('Meta/Smart Aide/.internals');
		expect(out.memory).toBe('Meta/Smart Aide/memory.md');
	});

	it('reflects a non-default metaDir like "sys"', () => {
		expect(derivedPathLabels('sys')).toEqual({
			chats: 'sys/Smart Aide/chats',
			skills: 'sys/skills',
			internals: 'sys/Smart Aide/.internals',
			agentsMd: 'sys/AGENTS.md',
			memory: 'sys/Smart Aide/memory.md',
		});
	});

	it('handles a nested metaDir', () => {
		const out = derivedPathLabels('plugins/smart-aide');
		expect(out.chats).toBe('plugins/smart-aide/Smart Aide/chats');
		expect(out.skills).toBe('plugins/smart-aide/skills');
		expect(out.agentsMd).toBe('plugins/smart-aide/AGENTS.md');
		expect(out.memory).toBe('plugins/smart-aide/Smart Aide/memory.md');
	});
});
