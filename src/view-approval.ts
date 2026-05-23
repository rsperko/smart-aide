import { Notice } from 'obsidian';
import { ApprovalPreview, Tool } from './types';
import { lineDiff } from './view-helpers';

export interface ApprovalDecision {
	approved: boolean;
	scope?: 'turn' | 'inherited-turn';
	reason?: string;
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
