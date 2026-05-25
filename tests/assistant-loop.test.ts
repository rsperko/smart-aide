import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, TFolder, Vault } from 'obsidian';
import { ChatStorage } from '../src/storage';
import type { ChatSession } from '../src/storage';
import { DEFAULT_SETTINGS, OPENROUTER_ID } from '../src/settings';
import type { SmartAideSettings } from '../src/settings';
import type { PinnedContext } from '../src/context-pins';
import type { SkillRegistry } from '../src/skills';
import type { ModelRef } from '../src/types';
import type {
	AssembledTurn,
	Provider,
	StreamCallbacks,
	ToolCall,
	TurnRequest,
	TurnUsage,
} from '../src/providers';
import type { ApprovalDecision } from '../src/view-approval';
import {
	LoopHost,
	MAX_TOOL_TURNS,
	runAssistantLoop,
} from '../src/assistant-loop';

// ---------- providerFor mock ----------

let currentProvider: Provider;

vi.mock('../src/providers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/providers')>();
	return {
		...actual,
		providerFor: () => currentProvider,
	};
});

// ---------- in-memory vault (mirrors storage.test.ts pattern) ----------

class InMemoryVault extends Vault {
	files = new Map<string, { content: string; mtime: number }>();
	folders = new Set<string>();

	getFileByPath(path: string): TFile | null {
		if (!this.files.has(path)) return null;
		const f = Object.assign(new TFile(), {
			path,
			name: path.split('/').pop() ?? '',
			extension: 'jsonl',
		});
		f.stat = { mtime: this.files.get(path)!.mtime, ctime: 0, size: 0 };
		return f;
	}
	async cachedRead(file: TFile): Promise<string> {
		return this.files.get(file.path)?.content ?? '';
	}
	async read(file: TFile): Promise<string> {
		return this.cachedRead(file);
	}
	async create(path: string, content: string): Promise<TFile> {
		this.files.set(path, { content, mtime: Date.now() });
		return this.getFileByPath(path)!;
	}
	async createFolder(path: string): Promise<TFolder> {
		this.folders.add(path);
		const f = new TFolder();
		f.path = path;
		return f;
	}
	async append(file: TFile, content: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`not found: ${file.path}`);
		entry.content += content;
	}
	adapter = {
		exists: async (p: string) => this.files.has(p) || this.folders.has(p),
	};
}

// ---------- scripted fake provider ----------

interface ScriptedTurn {
	text?: string;
	toolCalls?: ToolCall[];
	usage?: TurnUsage;
	throws?: Error;
	/** If set, runTurn waits until this resolves before returning (so the test
	 * can trigger an abort mid-stream). */
	awaitBeforeReturn?: Promise<void>;
}

function makeScriptedProvider(turns: ScriptedTurn[]): Provider {
	let idx = 0;
	return {
		capabilities: { supportsCachedPrompt: false },
		async *streamTurn(): AsyncGenerator<never> {
			throw new Error('streamTurn not used in loop tests');
		},
		async runTurn(req: TurnRequest, _resolveImage, cb?: StreamCallbacks): Promise<AssembledTurn> {
			if (idx >= turns.length) {
				throw new Error(`scripted provider: out of turns at index ${idx}`);
			}
			const t = turns[idx++];
			if (t.text) cb?.onText?.(t.text);
			for (let i = 0; i < (t.toolCalls?.length ?? 0); i++) {
				const tc = t.toolCalls![i];
				cb?.onToolCallProgress?.(i, { id: tc.id, name: tc.name, argsAccum: tc.arguments });
			}
			if (t.awaitBeforeReturn) await t.awaitBeforeReturn;
			if (t.throws) throw t.throws;
			if (t.usage) cb?.onUsage?.(t.usage);
			return {
				text: t.text ?? '',
				toolCalls: t.toolCalls ?? [],
				finishReason: 'stop',
				usage: t.usage,
			};
		},
		async discoverModels() {
			return [];
		},
	};
}

// ---------- recording host ----------

interface HostRecording {
	calls: string[];
	rerenders: number;
	liveTurns: number;
	usages: TurnUsage[];
	loopStarts: number;
	loopEnds: number;
	approvalRequests: ToolCall[][];
	toolCalls: { name: string; args: Record<string, unknown>; decision?: ApprovalDecision }[];
	skillsLoaded: { name: string; body: string }[];
}

function makeHost(opts: {
	session: ChatSession;
	storage: ChatStorage;
	settings?: SmartAideSettings;
	modelRef?: ModelRef;
	approvalDecisions?: (calls: ToolCall[]) => {
		writes?: Record<string, ApprovalDecision>;
		deletes?: Record<string, ApprovalDecision>;
		turnGrantsApproveAll?: boolean;
	};
	toolResult?: (name: string, args: Record<string, unknown>) => string;
	onRerender?: () => void;
}): { host: LoopHost; rec: HostRecording } {
	const rec: HostRecording = {
		calls: [],
		rerenders: 0,
		liveTurns: 0,
		usages: [],
		loopStarts: 0,
		loopEnds: 0,
		approvalRequests: [],
		toolCalls: [],
		skillsLoaded: [],
	};
	const host: LoopHost = {
		session: opts.session,
		settings: opts.settings ?? DEFAULT_SETTINGS,
		storage: opts.storage,
		skills: { loadable: () => null, visibleOnThisPlatform: () => [] } as unknown as SkillRegistry,
		pinned: { buildPreamble: async () => '' } as unknown as PinnedContext,
		modelRef: opts.modelRef ?? { endpointId: OPENROUTER_ID, slug: 'fake-model' },
		composeSystemPrompt: () => 'system',
		newLiveTurn: () => {
			rec.liveTurns++;
			return {
				onText: () => undefined,
				onToolProgress: () => undefined,
				onUsage: () => undefined,
				end: () => rec.calls.push('renderer.end'),
				error: (kind, _msg) => rec.calls.push(`renderer.error:${kind}`),
			};
		},
		rerenderStream: () => {
			rec.rerenders++;
			rec.calls.push('rerender');
			opts.onRerender?.();
		},
		recordTurnUsage: (u) => {
			rec.usages.push(u);
		},
		collectApprovals: async (calls) => {
			rec.approvalRequests.push(calls);
			const writeDecisions = new Map<string, ApprovalDecision>();
			const deleteDecisions = new Map<string, ApprovalDecision>();
			const spec = opts.approvalDecisions?.(calls);
			for (const [id, d] of Object.entries(spec?.writes ?? {})) writeDecisions.set(id, d);
			for (const [id, d] of Object.entries(spec?.deletes ?? {})) deleteDecisions.set(id, d);
			return {
				writeDecisions,
				deleteDecisions,
				turnGrantsApproveAll: spec?.turnGrantsApproveAll ?? false,
			};
		},
		runOneToolCall: async (name, args, decision, pending) => {
			rec.toolCalls.push({ name, args, decision });
			if (name === 'load_skill') {
				const skillName = String(args.name ?? '');
				pending.push({ name: skillName, body: `body-of-${skillName}` });
				rec.skillsLoaded.push({ name: skillName, body: `body-of-${skillName}` });
				return JSON.stringify({ status: 'loaded', skill: skillName });
			}
			return opts.toolResult?.(name, args) ?? JSON.stringify({ status: 'ok' });
		},
		onLoopStart: () => {
			rec.loopStarts++;
			rec.calls.push('loopStart');
		},
		onLoopEnd: () => {
			rec.loopEnds++;
			rec.calls.push('loopEnd');
		},
	};
	return { host, rec };
}

async function freshSession(): Promise<{ storage: ChatStorage; session: ChatSession; vault: InMemoryVault }> {
	const vault = new InMemoryVault();
	const storage = new ChatStorage(vault as unknown as Vault, 'Meta/chats');
	const session = await storage.createChat();
	// Seed with a user message so contextChain has something to walk.
	const user = storage.makeMessageEntry({ role: 'user', content: 'hello' }, null);
	await storage.appendEntry(session, user);
	session.leafId = user.id;
	return { storage, session, vault };
}

// ---------- tests ----------

describe('runAssistantLoop', () => {
	beforeEach(() => {
		currentProvider = makeScriptedProvider([{ text: 'placeholder' }]);
	});

	it('single text-only turn: persists assistant + usage, no approvals', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{
				text: 'hello back',
				usage: { promptTokens: 10, completionTokens: 4 },
			},
		]);
		const { host, rec } = makeHost({ session, storage });
		const ctrl = new AbortController();

		await runAssistantLoop(host, null, ctrl.signal);

		const tail = session.entries.slice(-2);
		expect(tail[0].type).toBe('message');
		expect(tail[1].type).toBe('custom');
		expect(rec.loopStarts).toBe(1);
		expect(rec.loopEnds).toBe(1);
		expect(rec.approvalRequests).toEqual([]);
		expect(rec.rerenders).toBe(1);
		expect(rec.usages).toEqual([{ promptTokens: 10, completionTokens: 4 }]);
	});

	it('persists usage with cached-token split preserved', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{
				text: 'k',
				usage: {
					promptTokens: 100,
					completionTokens: 5,
					cachedReadTokens: 80,
					cachedWriteTokens: 0,
				},
			},
		]);
		const { host } = makeHost({ session, storage });
		await runAssistantLoop(host, null, new AbortController().signal);

		const usage = session.entries.find(
			(e) => e.type === 'custom' && e.customType === 'turn-usage',
		);
		expect(usage).toBeTruthy();
		const data = (usage as { data: Record<string, unknown> }).data;
		expect(data.promptTokens).toBe(100);
		expect(data.completionTokens).toBe(5);
		expect(data.cachedTokens).toBe(80);
	});

	it('writes a tool call: collectApprovals fires, runOneToolCall executes, result entry persisted', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{ toolCalls: [{ id: 'tc1', name: 'write_note', arguments: '{"path":"x.md","content":"hi"}' }] },
			{ text: 'wrote it' },
		]);
		const { host, rec } = makeHost({
			session,
			storage,
			approvalDecisions: () => ({ writes: { tc1: { approved: true } } }),
			toolResult: () => JSON.stringify({ status: 'created' }),
		});

		await runAssistantLoop(host, null, new AbortController().signal);

		expect(rec.approvalRequests).toHaveLength(1);
		expect(rec.toolCalls).toEqual([
			{ name: 'write_note', args: { path: 'x.md', content: 'hi' }, decision: { approved: true } },
		]);
		// rerender called twice (after assistant entry, after tool result), plus once for the final text turn.
		expect(rec.rerenders).toBeGreaterThanOrEqual(3);

		const toolEntry = session.entries.find(
			(e) => e.type === 'message' && e.message.role === 'tool',
		);
		expect(toolEntry).toBeTruthy();
	});

	it('skill load is persisted AFTER the tool-result entry', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{ toolCalls: [{ id: 'tc1', name: 'load_skill', arguments: '{"name":"daily"}' }] },
			{ text: 'used the skill' },
		]);
		const { host } = makeHost({ session, storage });

		await runAssistantLoop(host, null, new AbortController().signal);

		// The custom_message (skill) must come AFTER the tool-result message —
		// providers require [assistant tool_call → tool result → user skill] adjacency.
		const toolIdx = session.entries.findIndex(
			(e) => e.type === 'message' && e.message.role === 'tool',
		);
		const skillIdx = session.entries.findIndex(
			(e) => e.type === 'custom_message' && e.customType === 'skill',
		);
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(skillIdx).toBeGreaterThan(toolIdx);
	});

	it('aborts mid-stream: renderer.error("aborted"), no assistant entry, loop unwinds', async () => {
		const { storage, session } = await freshSession();
		const ctrl = new AbortController();
		const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
		currentProvider = makeScriptedProvider([{ throws: abortErr }]);
		const entriesBefore = session.entries.length;
		const { host, rec } = makeHost({ session, storage });

		await runAssistantLoop(host, null, ctrl.signal);

		expect(rec.calls).toContain('renderer.error:aborted');
		expect(rec.loopEnds).toBe(1);
		expect(session.entries.length).toBe(entriesBefore);
	});

	it('provider error (non-abort): renderer.error("error"), loop unwinds, onLoopEnd fires', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([{ throws: new Error('http 500') }]);
		const { host, rec } = makeHost({ session, storage });

		await runAssistantLoop(host, null, new AbortController().signal);

		expect(rec.calls).toContain('renderer.error:error');
		expect(rec.loopEnds).toBe(1);
	});

	it('aborts between turns: tool result persisted, next iteration skipped', async () => {
		const { storage, session } = await freshSession();
		const ctrl = new AbortController();
		currentProvider = makeScriptedProvider([
			{ toolCalls: [{ id: 'tc1', name: 'write_note', arguments: '{"path":"x.md","content":"hi"}' }] },
			{ text: 'second turn — should never run' },
		]);
		let rerenderCount = 0;
		const { host, rec } = makeHost({
			session,
			storage,
			approvalDecisions: () => ({ writes: { tc1: { approved: true } } }),
			onRerender: () => {
				rerenderCount++;
				// Abort AFTER the tool-result rerender (second rerender of the first turn).
				if (rerenderCount === 2) ctrl.abort();
			},
		});

		await runAssistantLoop(host, null, ctrl.signal);

		// Only the first turn's provider call should have happened.
		expect(rec.liveTurns).toBe(1);
		expect(rec.loopEnds).toBe(1);
	});

	it('hits MAX_TOOL_TURNS cap: persists the cap notice', async () => {
		const { storage, session } = await freshSession();
		// Every turn returns a tool call, so the loop runs all 8 and hits the cap.
		const turns: ScriptedTurn[] = [];
		for (let i = 0; i < MAX_TOOL_TURNS; i++) {
			turns.push({
				toolCalls: [{ id: `tc${i}`, name: 'load_skill', arguments: '{"name":"x"}' }],
			});
		}
		currentProvider = makeScriptedProvider(turns);
		const { host } = makeHost({ session, storage });

		await runAssistantLoop(host, null, new AbortController().signal);

		const capEntry = [...session.entries].reverse().find(
			(e) =>
				e.type === 'message' &&
				e.message.role === 'assistant' &&
				typeof e.message.content === 'string' &&
				e.message.content.includes(`Stopped after ${MAX_TOOL_TURNS} tool turns`),
		);
		expect(capEntry).toBeTruthy();
	});

	it('approveAllInTurn flag lifts across turns', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{ toolCalls: [{ id: 'a', name: 'write_note', arguments: '{"path":"a.md","content":""}' }] },
			{ toolCalls: [{ id: 'b', name: 'write_note', arguments: '{"path":"b.md","content":""}' }] },
			{ text: 'done' },
		]);
		const approvalSpy = vi.fn((_calls: ToolCall[]) => ({
			writes: { a: { approved: true, scope: 'turn' as const } },
			turnGrantsApproveAll: true,
		}));
		// On turn 2, the host should see approveAllInTurn=true via the loop's local state.
		const seenFlags: boolean[] = [];
		const { storage: s2, session: sess2 } = await freshSession();
		const host: LoopHost = {
			session: sess2,
			settings: DEFAULT_SETTINGS,
			storage: s2,
			skills: { loadable: () => null, visibleOnThisPlatform: () => [] } as unknown as SkillRegistry,
			pinned: { buildPreamble: async () => '' } as unknown as PinnedContext,
			modelRef: { endpointId: OPENROUTER_ID, slug: 'fake' },
			composeSystemPrompt: () => 'system',
			newLiveTurn: () => ({
				onText: () => undefined,
				onToolProgress: () => undefined,
				onUsage: () => undefined,
				end: () => undefined,
				error: () => undefined,
			}),
			rerenderStream: () => undefined,
			recordTurnUsage: () => undefined,
			collectApprovals: async (calls, opts) => {
				seenFlags.push(opts.approveAllInTurn);
				const map = new Map<string, ApprovalDecision>();
				if (calls[0]?.id === 'a') {
					map.set('a', { approved: true, scope: 'turn' });
					return { writeDecisions: map, deleteDecisions: new Map(), turnGrantsApproveAll: true };
				}
				map.set('b', { approved: true });
				return { writeDecisions: map, deleteDecisions: new Map(), turnGrantsApproveAll: false };
			},
			runOneToolCall: async () => JSON.stringify({ status: 'ok' }),
			onLoopStart: () => undefined,
			onLoopEnd: () => undefined,
		};

		await runAssistantLoop(host, null, new AbortController().signal);

		expect(seenFlags).toEqual([false, true]);
		// Avoid unused warning on the unused outer spy.
		expect(approvalSpy).not.toHaveBeenCalled();
	});

	it('mixed turn: write + delete + read calls — each routed to the right decision map, read bypasses approval', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{
				toolCalls: [
					{ id: 'r', name: 'search_vault', arguments: '{"query":"x"}' },
					{ id: 'w', name: 'write_note', arguments: '{"path":"a.md","content":"hi"}' },
					{ id: 'd', name: 'delete_note', arguments: '{"path":"b.md"}' },
				],
			},
			{ text: 'all done' },
		]);
		const { host, rec } = makeHost({
			session,
			storage,
			approvalDecisions: () => ({
				writes: { w: { approved: true } },
				deletes: { d: { approved: false, reason: 'no' } },
			}),
			toolResult: (name) => JSON.stringify({ tool: name }),
		});

		await runAssistantLoop(host, null, new AbortController().signal);

		// Every tool call ran through runOneToolCall, but only writes + deletes
		// had a decision attached — the read call's decision is undefined.
		expect(rec.toolCalls).toEqual([
			{ name: 'search_vault', args: { query: 'x' }, decision: undefined },
			{ name: 'write_note', args: { path: 'a.md', content: 'hi' }, decision: { approved: true } },
			{ name: 'delete_note', args: { path: 'b.md' }, decision: { approved: false, reason: 'no' } },
		]);
	});

	it('tool-result roundtrip: runOneToolCall return becomes the persisted toolResult block', async () => {
		const { storage, session } = await freshSession();
		currentProvider = makeScriptedProvider([
			{
				toolCalls: [
					{ id: 'tc1', name: 'search_vault', arguments: '{"query":"deep work"}' },
				],
			},
			{ text: 'found it' },
		]);
		const { host } = makeHost({
			session,
			storage,
			toolResult: (_name, args) =>
				JSON.stringify({ matches: 1, query: args.query, results: [{ path: 'note.md' }] }),
		});

		await runAssistantLoop(host, null, new AbortController().signal);

		const toolEntry = session.entries.find(
			(e) => e.type === 'message' && e.message.role === 'tool',
		);
		expect(toolEntry?.type).toBe('message');
		const content = (toolEntry as { message: { content: unknown[] } }).message.content;
		expect(Array.isArray(content)).toBe(true);
		const block = (content as Array<{ type: string; toolCallId: string; content: string }>)[0];
		expect(block.type).toBe('toolResult');
		expect(block.toolCallId).toBe('tc1');
		expect(JSON.parse(block.content)).toEqual({
			matches: 1,
			query: 'deep work',
			results: [{ path: 'note.md' }],
		});
	});
});
