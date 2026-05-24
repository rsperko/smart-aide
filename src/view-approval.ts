import { Notice } from 'obsidian';
import { ApprovalPreview, Tool } from './types';
import { lineDiff } from './view-helpers';

export interface ApprovalDecision {
	approved: boolean;
	scope?: 'turn' | 'inherited-turn';
	reason?: string;
}

export interface BatchApprovalItem {
	callId: string;
	tool: Tool;
	args: Record<string, unknown>;
	preview: ApprovalPreview;
}

interface ApprovalHost {
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		callback: (ev: HTMLElementEventMap[K]) => unknown,
	): void;
}

/**
 * Render an inline approval card into `container` and resolve when the user
 * decides (or the abortSignal fires). The card stays in the DOM after the
 * decision, with a class that surfaces the outcome — approvals become a durable
 * audit trail in the rendered chat.
 */
export function requestApproval(
	host: ApprovalHost,
	container: HTMLElement,
	scrollAfter: () => void,
	tool: Tool,
	preview: ApprovalPreview,
	abortSignal?: AbortSignal,
): Promise<ApprovalDecision> {
	return new Promise((resolve) => {
		const card = container.createDiv({ cls: 'vk-approval vk-approval-pending' });

		const header = card.createDiv({ cls: 'vk-approval-header' });
		header.createSpan({ cls: 'vk-approval-lock', text: tool.risk === 'delete' ? '🗑' : '✎' });
		header.createSpan({ cls: 'vk-approval-summary', text: preview.summary });

		if (preview.diff) {
			const diffEl = card.createDiv({ cls: 'vk-approval-diff' });
			renderDiff(diffEl, preview.diff);
		}

		const actions = card.createDiv({ cls: 'vk-approval-actions' });
		const rejectBtn = actions.createEl('button', { cls: 'vk-approval-btn vk-approval-reject', text: 'Reject' });
		const approveBtn = actions.createEl('button', { cls: 'vk-approval-btn vk-approval-approve', text: 'Approve' });
		let approveAllBtn: HTMLButtonElement | null = null;
		if (tool.risk === 'write') {
			approveAllBtn = actions.createEl('button', { cls: 'vk-approval-btn vk-approval-approve-all', text: 'Approve all writes in this turn' });
		}

		let settled = false;
		let abortListener: (() => void) | null = null;
		const decide = (decision: ApprovalDecision, cancelled = false) => {
			if (settled) return;
			settled = true;
			if (abortListener && abortSignal) abortSignal.removeEventListener('abort', abortListener);
			card.removeClass('vk-approval-pending');
			card.addClass(
				cancelled
					? 'vk-approval-decided-cancelled'
					: decision.approved
						? 'vk-approval-decided-approved'
						: 'vk-approval-decided-rejected',
			);
			actions.empty();
			const label = cancelled
				? '⊘ Cancelled — stopped'
				: decision.approved
					? `✓ Approved${decision.scope === 'turn' ? ' (all in turn)' : ''}`
					: '✗ Rejected';
			actions.createSpan({ cls: 'vk-approval-decision', text: label });
			resolve(decision);
			scrollAfter();
		};

		host.registerDomEvent(rejectBtn, 'click', () => decide({ approved: false, reason: 'User clicked Reject.' }));
		host.registerDomEvent(approveBtn, 'click', () => decide({ approved: true }));
		if (approveAllBtn) {
			host.registerDomEvent(approveAllBtn, 'click', () => decide({ approved: true, scope: 'turn' }));
		}

		if (abortSignal) {
			if (abortSignal.aborted) {
				decide({ approved: false, reason: 'Stopped by user.' }, true);
			} else {
				abortListener = () => decide({ approved: false, reason: 'Stopped by user.' }, true);
				abortSignal.addEventListener('abort', abortListener);
			}
		}

		new Notice(`Approval needed: ${preview.summary}`, 4000);
	});
}

/**
 * One card, N write proposals, per-item checkboxes. The user can approve a
 * subset (typical when the model gets one of several writes wrong), and a
 * single "auto-approve future writes in this turn" toggle covers the whole rest
 * of the turn. Delete operations are NOT batched — they keep their own
 * single-item card with explicit confirmation per file.
 */
export function requestBatchedWriteApprovals(
	host: ApprovalHost,
	container: HTMLElement,
	scrollAfter: () => void,
	items: BatchApprovalItem[],
	abortSignal?: AbortSignal,
): Promise<Map<string, ApprovalDecision>> {
	return new Promise((resolve) => {
		const card = container.createDiv({ cls: 'vk-approval vk-approval-pending vk-approval-batch' });

		const header = card.createDiv({ cls: 'vk-approval-header' });
		header.createSpan({ cls: 'vk-approval-lock', text: '✎' });
		header.createSpan({
			cls: 'vk-approval-summary',
			text: `${items.length} write${items.length === 1 ? '' : 's'} pending approval`,
		});

		const list = card.createDiv({ cls: 'vk-approval-batch-list' });
		const itemControls: { id: string; checkbox: HTMLInputElement }[] = [];
		for (const item of items) {
			const row = list.createDiv({ cls: 'vk-approval-batch-row' });
			const checkLabel = row.createEl('label', { cls: 'vk-approval-batch-check' });
			const checkbox = checkLabel.createEl('input', { type: 'checkbox' });
			checkbox.checked = true;
			checkLabel.createSpan({
				cls: 'vk-approval-batch-rowsummary',
				text: item.preview.summary,
			});
			itemControls.push({ id: item.callId, checkbox });
			if (item.preview.diff) {
				const diffWrap = row.createDiv({ cls: 'vk-approval-batch-diff' });
				renderDiff(diffWrap, item.preview.diff);
			}
		}

		const actions = card.createDiv({ cls: 'vk-approval-actions' });
		const rejectBtn = actions.createEl('button', {
			cls: 'vk-approval-btn vk-approval-reject',
			text: 'Reject all',
		});
		const approveBtn = actions.createEl('button', {
			cls: 'vk-approval-btn vk-approval-approve',
			text: 'Approve selected',
		});
		const allTurnLabel = actions.createEl('label', { cls: 'vk-approval-batch-allturn' });
		const allTurnCb = allTurnLabel.createEl('input', { type: 'checkbox' });
		allTurnLabel.createSpan({ text: 'auto-approve future writes in this turn' });

		let settled = false;
		let abortListener: (() => void) | null = null;
		const finalize = (
			decisions: Map<string, ApprovalDecision>,
			label: string,
			klass: string,
		): void => {
			if (settled) return;
			settled = true;
			if (abortListener && abortSignal) abortSignal.removeEventListener('abort', abortListener);
			card.removeClass('vk-approval-pending');
			card.addClass(klass);
			actions.empty();
			actions.createSpan({ cls: 'vk-approval-decision', text: label });
			for (const { checkbox } of itemControls) checkbox.disabled = true;
			allTurnCb.disabled = true;
			resolve(decisions);
			scrollAfter();
		};

		host.registerDomEvent(rejectBtn, 'click', () => {
			const map = new Map<string, ApprovalDecision>();
			for (const item of items) {
				map.set(item.callId, { approved: false, reason: 'User clicked Reject all.' });
			}
			finalize(map, '✗ Rejected all', 'vk-approval-decided-rejected');
		});

		host.registerDomEvent(approveBtn, 'click', () => {
			const map = new Map<string, ApprovalDecision>();
			let approvedCount = 0;
			for (const { id, checkbox } of itemControls) {
				if (checkbox.checked) {
					map.set(
						id,
						allTurnCb.checked ? { approved: true, scope: 'turn' } : { approved: true },
					);
					approvedCount++;
				} else {
					map.set(id, { approved: false, reason: 'Unchecked in batch.' });
				}
			}
			const label =
				approvedCount === items.length
					? `✓ Approved all ${approvedCount}${allTurnCb.checked ? ' (and rest of turn)' : ''}`
					: `✓ Approved ${approvedCount} of ${items.length}`;
			finalize(map, label, 'vk-approval-decided-approved');
		});

		if (abortSignal) {
			const cancelAll = (): void => {
				const map = new Map<string, ApprovalDecision>();
				for (const item of items) {
					map.set(item.callId, { approved: false, reason: 'Stopped by user.' });
				}
				finalize(map, '⊘ Cancelled — stopped', 'vk-approval-decided-cancelled');
			};
			if (abortSignal.aborted) {
				cancelAll();
			} else {
				abortListener = cancelAll;
				abortSignal.addEventListener('abort', abortListener);
			}
		}

		new Notice(
			`Approval needed: ${items.length} write${items.length === 1 ? '' : 's'}`,
			4000,
		);
	});
}

export function renderDiff(parent: HTMLElement, diff: NonNullable<ApprovalPreview['diff']>): void {
	if (diff.kind === 'delete') {
		parent.createDiv({ cls: 'vk-diff-note', text: 'This will move the file to trash.' });
		if (diff.oldContent !== undefined) {
			const pre = parent.createEl('pre', { cls: 'vk-diff-preview vk-diff-remove' });
			const preview = diff.oldContent.length > 800 ? diff.oldContent.slice(0, 800) + '\n…(truncated)' : diff.oldContent;
			pre.setText(preview);
		}
		return;
	}
	if (diff.kind === 'append') {
		parent.createDiv({ cls: 'vk-diff-note', text: 'Append to end of file:' });
		const pre = parent.createEl('pre', { cls: 'vk-diff-preview vk-diff-add' });
		pre.setText(diff.newContent ?? '');
		return;
	}
	// overwrite — show line-by-line diff
	const oldLines = (diff.oldContent ?? '').split('\n');
	const newLines = (diff.newContent ?? '').split('\n');
	const ops = lineDiff(oldLines, newLines);
	const pre = parent.createEl('div', { cls: 'vk-diff-lines' });
	for (const op of ops) {
		const cls =
			op.type === 'add'
				? 'vk-diff-line vk-diff-add'
				: op.type === 'remove'
					? 'vk-diff-line vk-diff-remove'
					: 'vk-diff-line vk-diff-context';
		const lineEl = pre.createDiv({ cls });
		const prefix = op.type === 'add' ? '+ ' : op.type === 'remove' ? '- ' : '  ';
		lineEl.setText(prefix + op.line);
	}
}
