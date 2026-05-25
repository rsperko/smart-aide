import type { ToolCall } from './providers/types';
import type { SkillRegistry } from './skills';
import type { Tool, ToolContext } from './types';
import {
	ApprovalDecision,
	BatchApprovalItem,
	requestApproval,
	requestBatchedWriteApprovals,
} from './view-approval';
import { handleSkillLoadCall, safeParse } from './view-helpers';
import { LOAD_SKILL_NAME } from './tools';

/**
 * Host capabilities the approval-collection step needs from the view. Kept
 * narrow so tests can supply a stub without a full ItemView. `registerDomEvent`
 * matches Obsidian's `Component` method shape so a real view can be passed
 * directly.
 */
export interface ApprovalCollectionHost {
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		callback: (ev: HTMLElementEventMap[K]) => unknown,
	): void;
	readonly streamEl: HTMLElement;
	scrollAfter(): void;
}

export interface ApprovalOptions {
	autoApproveWrites: boolean;
	approveAllInTurn: boolean;
	abortSignal?: AbortSignal;
}

export interface ApprovalCollectionResult {
	writeDecisions: Map<string, ApprovalDecision>;
	deleteDecisions: Map<string, ApprovalDecision>;
	/** True when the user toggled "auto-approve future writes in this turn" on
	 * the batch card. The caller mutates its per-turn flag. */
	turnGrantsApproveAll: boolean;
}

/**
 * Build approval previews for every write/delete in a tool-call batch and
 * resolve their decisions. Writes route through ONE batched card (or are
 * pre-approved via autoApproveWrites / approveAllInTurn). Deletes confirm
 * individually — one wrong delete is worse than five wrong appends.
 */
export async function collectApprovals(
	host: ApprovalCollectionHost,
	calls: ToolCall[],
	tools: Tool[],
	toolCtx: ToolContext,
	opts: ApprovalOptions,
): Promise<ApprovalCollectionResult> {
	const writeDecisions = new Map<string, ApprovalDecision>();
	const deleteDecisions = new Map<string, ApprovalDecision>();
	const writeItems: BatchApprovalItem[] = [];
	const deleteItems: BatchApprovalItem[] = [];

	for (const tc of calls) {
		if (tc.name === LOAD_SKILL_NAME) continue;
		const tool = tools.find((t) => t.name === tc.name);
		if (!tool) continue;
		if (tool.risk !== 'write' && tool.risk !== 'delete') continue;
		const args = safeParse(tc.arguments);
		let preview;
		try {
			preview = tool.preview
				? await tool.preview(args, toolCtx)
				: { summary: `${tc.name}(${Object.keys(args).join(', ')})` };
		} catch (e) {
			preview = { summary: `${tc.name} — preview failed: ${(e as Error).message}` };
		}
		const item: BatchApprovalItem = { callId: tc.id, tool, args, preview };
		if (tool.risk === 'write') writeItems.push(item);
		else deleteItems.push(item);
	}

	let turnGrantsApproveAll = false;
	if (writeItems.length > 0) {
		if (opts.abortSignal?.aborted) {
			for (const item of writeItems) {
				writeDecisions.set(item.callId, { approved: false, reason: 'Stopped by user.' });
			}
		} else if (opts.autoApproveWrites || opts.approveAllInTurn) {
			for (const item of writeItems) {
				writeDecisions.set(item.callId, { approved: true, scope: 'inherited-turn' });
			}
		} else {
			const result = await requestBatchedWriteApprovals(
				host,
				host.streamEl,
				() => host.scrollAfter(),
				writeItems,
				opts.abortSignal,
			);
			for (const [id, d] of result) {
				writeDecisions.set(id, d);
				if (d.approved && d.scope === 'turn') turnGrantsApproveAll = true;
			}
		}
	}

	for (const item of deleteItems) {
		if (opts.abortSignal?.aborted) {
			deleteDecisions.set(item.callId, { approved: false, reason: 'Stopped by user.' });
			continue;
		}
		const decision = await requestApproval(
			host,
			host.streamEl,
			() => host.scrollAfter(),
			item.tool,
			item.preview,
			opts.abortSignal,
		);
		deleteDecisions.set(item.callId, decision);
	}

	return { writeDecisions, deleteDecisions, turnGrantsApproveAll };
}

export interface RunToolDeps {
	tools: Tool[];
	skills: SkillRegistry;
	toolCtx: ToolContext;
	/** Persist an audit entry for a write/delete decision. Called regardless of
	 * approval outcome so the chat history captures the choice. */
	persistAudit(name: string, args: Record<string, unknown>, decision: ApprovalDecision): Promise<void>;
	/** Names of skills already loaded on the active chain — used by load_skill
	 * to short-circuit duplicate loads in the same branch. */
	getLoadedSkillNames(): Set<string>;
}

/**
 * Run one tool call given a pre-computed approval decision for write/delete
 * tools. Reads execute immediately; load_skill is routed through skill-load
 * persistence (caller drains pendingSkillLoads after the tool-result entry).
 */
export async function runOneToolCall(
	name: string,
	args: Record<string, unknown>,
	preDecision: ApprovalDecision | undefined,
	pendingSkillLoads: { name: string; body: string }[],
	deps: RunToolDeps,
): Promise<string> {
	if (name === LOAD_SKILL_NAME) {
		return handleSkillLoadCall(args, deps.skills, pendingSkillLoads, deps.getLoadedSkillNames());
	}

	const tool = deps.tools.find((t) => t.name === name);
	if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` });

	if (tool.risk === 'write' || tool.risk === 'delete') {
		const decision = preDecision ?? { approved: false, reason: 'No approval recorded.' };
		await deps.persistAudit(name, args, decision);
		if (!decision.approved) {
			return JSON.stringify({
				status: 'denied',
				reason: decision.reason ?? 'User rejected the operation.',
			});
		}
	}

	try {
		return await tool.execute(args, deps.toolCtx);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return JSON.stringify({ error: `tool ${name} failed: ${msg}` });
	}
}
