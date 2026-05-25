import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import { collectApprovals, runOneToolCall } from '../src/assistant-tools';
import type { ToolCall } from '../src/providers/types';
import type { ApprovalDecision } from '../src/view-approval';
import type { Tool, ToolContext } from '../src/types';
import type { SkillRegistry } from '../src/skills';

function makeHost() {
	return {
		registerDomEvent: vi.fn(),
		streamEl: {} as HTMLElement,
		scrollAfter: vi.fn(),
	};
}

function makeTool(partial: Partial<Tool>): Tool {
	return {
		name: 'fake',
		description: '',
		parameters: { type: 'object', properties: {} },
		risk: 'read',
		async execute() {
			return JSON.stringify({ status: 'ok' });
		},
		...partial,
	};
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
	return { id, name, arguments: JSON.stringify(args) };
}

function makeCtx(): ToolContext {
	return { app: new App(), metaDir: 'Meta' };
}

function makeSkillRegistryStub(): SkillRegistry {
	return {
		loadable: () => null,
		visibleOnThisPlatform: () => [],
	} as unknown as SkillRegistry;
}

// ---------- collectApprovals ----------

describe('collectApprovals', () => {
	it('returns empty maps when no write/delete tools are called', async () => {
		const host = makeHost();
		const tools = [makeTool({ name: 'reader', risk: 'read' })];
		const result = await collectApprovals(
			host,
			[call('1', 'reader')],
			tools,
			makeCtx(),
			{ autoApproveWrites: false, approveAllInTurn: false },
		);
		expect(result.writeDecisions.size).toBe(0);
		expect(result.deleteDecisions.size).toBe(0);
		expect(result.turnGrantsApproveAll).toBe(false);
	});

	it('skips load_skill and unknown tools', async () => {
		const host = makeHost();
		const tools = [makeTool({ name: 'writer', risk: 'write' })];
		const result = await collectApprovals(
			host,
			[call('1', 'load_skill', { name: 'x' }), call('2', 'unknown')],
			tools,
			makeCtx(),
			{ autoApproveWrites: false, approveAllInTurn: false },
		);
		expect(result.writeDecisions.size).toBe(0);
		expect(result.deleteDecisions.size).toBe(0);
	});

	it('autoApproveWrites pre-approves every write without a card', async () => {
		const host = makeHost();
		const preview = vi.fn(async () => ({ summary: 'Write x' }));
		const tools = [makeTool({ name: 'writer', risk: 'write', preview })];
		const result = await collectApprovals(
			host,
			[call('a', 'writer'), call('b', 'writer')],
			tools,
			makeCtx(),
			{ autoApproveWrites: true, approveAllInTurn: false },
		);
		expect(result.writeDecisions.get('a')).toEqual({ approved: true, scope: 'inherited-turn' });
		expect(result.writeDecisions.get('b')).toEqual({ approved: true, scope: 'inherited-turn' });
		// Preview is still built (the batch card would need it), but no DOM card was rendered.
		expect(preview).toHaveBeenCalledTimes(2);
	});

	it('approveAllInTurn pre-approves writes (same effect as autoApproveWrites)', async () => {
		const host = makeHost();
		const tools = [makeTool({ name: 'writer', risk: 'write' })];
		const result = await collectApprovals(
			host,
			[call('a', 'writer')],
			tools,
			makeCtx(),
			{ autoApproveWrites: false, approveAllInTurn: true },
		);
		expect(result.writeDecisions.get('a')).toEqual({ approved: true, scope: 'inherited-turn' });
	});

	it('aborted signal denies every write and delete without rendering a card', async () => {
		const host = makeHost();
		const ctrl = new AbortController();
		ctrl.abort();
		const tools = [
			makeTool({ name: 'writer', risk: 'write' }),
			makeTool({ name: 'remover', risk: 'delete' }),
		];
		const result = await collectApprovals(
			host,
			[call('w', 'writer'), call('d', 'remover')],
			tools,
			makeCtx(),
			{ autoApproveWrites: false, approveAllInTurn: false, abortSignal: ctrl.signal },
		);
		expect(result.writeDecisions.get('w')).toEqual({ approved: false, reason: 'Stopped by user.' });
		expect(result.deleteDecisions.get('d')).toEqual({ approved: false, reason: 'Stopped by user.' });
	});

	it('preview throw surfaces as fallback summary (does not crash collection)', async () => {
		const host = makeHost();
		const tools = [
			makeTool({
				name: 'writer',
				risk: 'write',
				preview: async () => {
					throw new Error('boom');
				},
			}),
		];
		// Auto-approve so we don't try to render a card. The point is just that
		// collection completes without throwing despite the preview failing.
		const result = await collectApprovals(
			host,
			[call('a', 'writer')],
			tools,
			makeCtx(),
			{ autoApproveWrites: true, approveAllInTurn: false },
		);
		expect(result.writeDecisions.get('a')?.approved).toBe(true);
	});
});

// ---------- runOneToolCall ----------

describe('runOneToolCall', () => {
	function makeDeps(overrides: {
		tools?: Tool[];
		skills?: SkillRegistry;
		persistAudit?: ReturnType<typeof vi.fn>;
		loadedSkillNames?: Set<string>;
	} = {}) {
		return {
			tools: overrides.tools ?? [],
			skills: overrides.skills ?? makeSkillRegistryStub(),
			toolCtx: makeCtx(),
			persistAudit: overrides.persistAudit ?? vi.fn(async () => undefined),
			getLoadedSkillNames: () => overrides.loadedSkillNames ?? new Set<string>(),
		};
	}

	it('returns error JSON for unknown tools', async () => {
		const out = await runOneToolCall('mystery', {}, undefined, [], makeDeps());
		expect(JSON.parse(out)).toEqual({ error: 'unknown tool: mystery' });
	});

	it('executes a read tool without invoking persistAudit', async () => {
		const tool = makeTool({
			name: 'reader',
			risk: 'read',
			execute: async () => JSON.stringify({ result: 42 }),
		});
		const deps = makeDeps({ tools: [tool] });
		const out = await runOneToolCall('reader', {}, undefined, [], deps);
		expect(JSON.parse(out)).toEqual({ result: 42 });
		expect(deps.persistAudit).not.toHaveBeenCalled();
	});

	it('approved write executes and audits', async () => {
		const tool = makeTool({
			name: 'writer',
			risk: 'write',
			execute: async () => JSON.stringify({ status: 'created' }),
		});
		const deps = makeDeps({ tools: [tool] });
		const decision: ApprovalDecision = { approved: true };
		const out = await runOneToolCall('writer', { path: 'x.md' }, decision, [], deps);
		expect(JSON.parse(out)).toEqual({ status: 'created' });
		expect(deps.persistAudit).toHaveBeenCalledWith('writer', { path: 'x.md' }, decision);
	});

	it('denied write returns denied JSON and audits, never executing', async () => {
		const execute = vi.fn();
		const tool = makeTool({ name: 'writer', risk: 'write', execute });
		const deps = makeDeps({ tools: [tool] });
		const decision: ApprovalDecision = { approved: false, reason: 'User clicked Reject.' };
		const out = await runOneToolCall('writer', {}, decision, [], deps);
		expect(JSON.parse(out)).toEqual({ status: 'denied', reason: 'User clicked Reject.' });
		expect(execute).not.toHaveBeenCalled();
		expect(deps.persistAudit).toHaveBeenCalledWith('writer', {}, decision);
	});

	it('write with no preDecision defaults to denied "No approval recorded"', async () => {
		const execute = vi.fn();
		const tool = makeTool({ name: 'writer', risk: 'write', execute });
		const deps = makeDeps({ tools: [tool] });
		const out = await runOneToolCall('writer', {}, undefined, [], deps);
		expect(JSON.parse(out)).toEqual({ status: 'denied', reason: 'No approval recorded.' });
		expect(execute).not.toHaveBeenCalled();
		expect(deps.persistAudit).toHaveBeenCalled();
	});

	it('execute throw is wrapped into error JSON', async () => {
		const tool = makeTool({
			name: 'reader',
			risk: 'read',
			execute: async () => {
				throw new Error('disk on fire');
			},
		});
		const out = await runOneToolCall('reader', {}, undefined, [], makeDeps({ tools: [tool] }));
		expect(JSON.parse(out)).toEqual({ error: 'tool reader failed: disk on fire' });
	});

	it('load_skill routes through handleSkillLoadCall and pushes onto pendingSkillLoads', async () => {
		const skill = { name: 'daily', body: 'do daily things', userInvocable: false } as unknown;
		const skills = {
			loadable: (n: string) => (n === 'daily' ? skill : null),
			visibleOnThisPlatform: () => [skill],
		} as unknown as SkillRegistry;
		const pending: { name: string; body: string }[] = [];
		const out = await runOneToolCall(
			'load_skill',
			{ name: 'daily' },
			undefined,
			pending,
			makeDeps({ skills }),
		);
		expect(JSON.parse(out)).toEqual({ status: 'loaded', skill: 'daily' });
		expect(pending).toEqual([{ name: 'daily', body: 'do daily things' }]);
	});

	it('load_skill short-circuits with already_loaded when the chain already has the skill', async () => {
		const skill = { name: 'daily', body: 'do daily things', userInvocable: false } as unknown;
		const skills = {
			loadable: (n: string) => (n === 'daily' ? skill : null),
			visibleOnThisPlatform: () => [skill],
		} as unknown as SkillRegistry;
		const pending: { name: string; body: string }[] = [];
		const out = await runOneToolCall(
			'load_skill',
			{ name: 'daily' },
			undefined,
			pending,
			makeDeps({ skills, loadedSkillNames: new Set(['daily']) }),
		);
		expect(JSON.parse(out)).toEqual({ status: 'already_loaded', skill: 'daily' });
		expect(pending).toEqual([]);
	});

	it('load_skill with unknown name returns error + available list', async () => {
		const known = { name: 'meeting-notes', body: '', userInvocable: false } as unknown;
		const skills = {
			loadable: () => null,
			visibleOnThisPlatform: () => [known],
		} as unknown as SkillRegistry;
		const pending: { name: string; body: string }[] = [];
		const out = await runOneToolCall(
			'load_skill',
			{ name: 'nope' },
			undefined,
			pending,
			makeDeps({ skills }),
		);
		const parsed = JSON.parse(out);
		expect(parsed.error).toMatch(/no skill named 'nope'/);
		expect(parsed.available).toEqual(['meeting-notes']);
		expect(pending).toEqual([]);
	});
});
