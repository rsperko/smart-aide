import type { ChatSession, ChatStorage } from './storage';
import type { PinnedContext } from './context-pins';
import type { SkillRegistry } from './skills';
import type { ToolCall, TurnUsage } from './providers';
import { providerFor } from './providers';
import type { ApprovalDecision } from './view-approval';
import type { ContentBlock, ModelRef } from './types';
import type { SmartAideSettings } from './settings';
import { resolveModelRef } from './settings';
import { LOAD_SKILL_TOOL_DEF, TOOLS, toolsToDescriptors } from './tools';
import { filterTools, safeParse } from './view-helpers';

export const MAX_TOOL_TURNS = 8;

/** Per-turn renderer the host wires up for live DOM updates. The loop calls
 * these as the stream progresses; the host owns the actual DOM. */
export interface LiveTurnRenderer {
	onText(delta: string): void;
	onToolProgress(index: number, partial: { id?: string; name?: string; argsAccum: string }): void;
	onUsage(u: TurnUsage): void;
	/** Remove the live elements once the persisted version is ready. */
	end(): void;
	/** Stream aborted or threw. Remove live elements, surface a Notice. */
	error(kind: 'aborted' | 'error', message: string): void;
}

export interface CollectApprovalsResult {
	writeDecisions: Map<string, ApprovalDecision>;
	deleteDecisions: Map<string, ApprovalDecision>;
	turnGrantsApproveAll: boolean;
}

export interface LoopHost {
	readonly session: ChatSession;
	readonly settings: SmartAideSettings;
	readonly storage: ChatStorage;
	readonly skills: SkillRegistry;
	readonly pinned: PinnedContext;
	readonly modelRef: ModelRef;

	composeSystemPrompt(): string;
	newLiveTurn(): LiveTurnRenderer;
	rerenderStream(): void;
	recordTurnUsage(u: TurnUsage): void;

	collectApprovals(
		calls: ToolCall[],
		opts: { approveAllInTurn: boolean; abortSignal: AbortSignal },
	): Promise<CollectApprovalsResult>;
	runOneToolCall(
		name: string,
		args: Record<string, unknown>,
		preDecision: ApprovalDecision | undefined,
		pendingSkillLoads: { name: string; body: string }[],
	): Promise<string>;

	onLoopStart(): void;
	onLoopEnd(): void;
}

/**
 * Drive an assistant turn (and any follow-up tool turns) end-to-end. The host
 * owns DOM, storage, and view-specific wrappers; this module owns the control
 * flow: stream → persist → approve → execute → persist results → loop or stop.
 *
 * `approveAllInTurn` lives as loop-local state — it resets every call (every
 * user turn) and lifts to `true` when a batch-approval card grants it.
 */
export async function runAssistantLoop(
	host: LoopHost,
	allowedTools: string[] | null,
	signal: AbortSignal,
): Promise<void> {
	host.onLoopStart();

	let approveAllInTurn = false;
	let hitTurnCap = false;

	try {
		for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
			// Re-read pinned context each iteration so file edits during the turn show up.
			const pinnedPreamble = (await host.pinned.buildPreamble()) || undefined;
			const renderer = host.newLiveTurn();

			const { endpoint, slug } = resolveModelRef(host.settings, host.modelRef);
			const provider = providerFor(endpoint);

			let assembled;
			try {
				assembled = await provider.runTurn(
					{
						endpoint,
						model: slug,
						chain: host.storage.contextChain(host.session),
						systemPrompt: host.composeSystemPrompt(),
						tools: filterTools(
							[...toolsToDescriptors(TOOLS), LOAD_SKILL_TOOL_DEF],
							allowedTools,
						),
						pinnedPreamble,
						enablePromptCaching: host.settings.anthropicPromptCaching,
						signal,
					},
					(path) => host.storage.resolveImageBytes(path),
					{
						onText: (delta) => renderer.onText(delta),
						onToolCallProgress: (index, partial) => renderer.onToolProgress(index, partial),
						onUsage: (u) => {
							host.recordTurnUsage(u);
							renderer.onUsage(u);
						},
					},
				);
			} catch (e) {
				if ((e as Error).name === 'AbortError') {
					renderer.error('aborted', 'Stopped.');
				} else {
					renderer.error('error', `Chat error: ${(e as Error).message}`);
				}
				break;
			}

			renderer.end();

			const blocks: ContentBlock[] = [];
			if (assembled.text) blocks.push({ type: 'text', text: assembled.text });
			for (const tc of assembled.toolCalls) {
				blocks.push({
					type: 'toolCall',
					id: tc.id,
					name: tc.name,
					arguments: safeParse(tc.arguments),
				});
			}
			const assistantEntry = host.storage.makeMessageEntry(
				{ role: 'assistant', content: blocks.length ? blocks : assembled.text || '' },
				host.session.leafId,
			);
			await host.storage.appendEntry(host.session, assistantEntry);

			if (assembled.usage) {
				const cached =
					(assembled.usage.cachedReadTokens ?? 0) + (assembled.usage.cachedWriteTokens ?? 0);
				const usageEntry = host.storage.makeCustomEntry(
					'turn-usage',
					{
						targetEntryId: assistantEntry.id,
						promptTokens: assembled.usage.promptTokens,
						completionTokens: assembled.usage.completionTokens,
						cachedTokens: cached || undefined,
					},
					host.session.leafId,
				);
				await host.storage.appendEntry(host.session, usageEntry);
			}

			// Render persisted state BEFORE approval cards — on mobile the card
			// otherwise lands below the viewport with nothing above it.
			host.rerenderStream();

			if (assembled.toolCalls.length === 0) break;

			// Writes batch into one card, deletes confirm individually. Skill loads
			// queue here and are appended AFTER the tool-result entry so providers
			// see [assistant tool_call → tool result → user skill context] — the
			// adjacency OpenAI / Anthropic / Gemini all require.
			const approvals = await host.collectApprovals(assembled.toolCalls, {
				approveAllInTurn,
				abortSignal: signal,
			});
			if (approvals.turnGrantsApproveAll) approveAllInTurn = true;

			const resultBlocks: ContentBlock[] = [];
			const pendingSkillLoads: { name: string; body: string }[] = [];
			for (const tc of assembled.toolCalls) {
				const args = safeParse(tc.arguments);
				const decision = approvals.writeDecisions.get(tc.id) ?? approvals.deleteDecisions.get(tc.id);
				const out = await host.runOneToolCall(tc.name, args, decision, pendingSkillLoads);
				resultBlocks.push({ type: 'toolResult', toolCallId: tc.id, content: out });
			}
			const toolEntry = host.storage.makeMessageEntry(
				{ role: 'tool', content: resultBlocks },
				host.session.leafId,
			);
			await host.storage.appendEntry(host.session, toolEntry);
			for (const skill of pendingSkillLoads) {
				const skillEntry = host.storage.makeCustomMessageEntry(
					'skill',
					skill.body,
					`skill: ${skill.name}`,
					host.session.leafId,
				);
				await host.storage.appendEntry(host.session, skillEntry);
			}
			host.rerenderStream();

			if (signal.aborted) break;
			if (turn === MAX_TOOL_TURNS - 1) {
				hitTurnCap = true;
				break;
			}
		}

		if (hitTurnCap) {
			const notice =
				`_Stopped after ${MAX_TOOL_TURNS} tool turns to avoid runaway tool use. ` +
				`Ask again if you want me to continue from here._`;
			const capEntry = host.storage.makeMessageEntry(
				{ role: 'assistant', content: notice },
				host.session.leafId,
			);
			await host.storage.appendEntry(host.session, capEntry);
			host.rerenderStream();
		}
	} finally {
		host.onLoopEnd();
	}
}
