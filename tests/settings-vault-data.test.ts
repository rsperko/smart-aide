import { describe, expect, it } from 'vitest';
import { derivedPathLabels } from '../src/settings-vault-data';

describe('derivedPathLabels', () => {
	it('composes chats / skills / internals / agents.md under Meta', () => {
		expect(derivedPathLabels('Meta')).toEqual({
			chats: 'Meta/chats',
			skills: 'Meta/skills',
			internals: 'Meta/.smart-aide',
			agentsMd: 'Meta/AGENTS.md',
		});
	});

	it('reflects a non-default metaDir like "sys"', () => {
		expect(derivedPathLabels('sys')).toEqual({
			chats: 'sys/chats',
			skills: 'sys/skills',
			internals: 'sys/.smart-aide',
			agentsMd: 'sys/AGENTS.md',
		});
	});

	it('handles a nested metaDir', () => {
		const out = derivedPathLabels('plugins/smart-aide');
		expect(out.chats).toBe('plugins/smart-aide/chats');
		expect(out.agentsMd).toBe('plugins/smart-aide/AGENTS.md');
	});
});
