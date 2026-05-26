import { App, Modal, Notice } from 'obsidian';
import { runEditRequest } from './edit-selection';
import { lineDiff } from './view-helpers';
import type SmartAidePlugin from './main';

type EditState = 'idle' | 'streaming' | 'done' | 'error';

/**
 * Inline edit modal. Captures the user's instruction, calls the chat model
 * once, shows the proposed rewrite as a unified diff, and (on Accept) hands
 * the rewrite back to the caller for `editor.replaceSelection`.
 *
 * State machine:
 *   idle      → prompt input visible, focus
 *   streaming → input locked, "Thinking…" status, Stop button (AbortController)
 *   done      → diff visible, Accept / Reject buttons
 *   error     → error message, input unlocked, Retry button
 *
 * Closing the modal aborts any in-flight request. Esc closes from idle/error.
 * Cmd/Ctrl+Enter submits from idle.
 */
export class EditSelectionModal extends Modal {
	private inputEl!: HTMLTextAreaElement;
	private statusEl!: HTMLElement;
	private diffEl!: HTMLElement;
	private actionsEl!: HTMLElement;

	private state: EditState = 'idle';
	private rewrite: string | null = null;
	private aborter: AbortController | null = null;
	private lastError: string | null = null;

	constructor(
		app: App,
		private plugin: SmartAidePlugin,
		selection: string,
		private onAccept: (newText: string) => void,
	) {
		super(app);
		console.log('[smart-aide] EditSelectionModal ctor: selection arg', {
			type: typeof selection,
			isString: typeof selection === 'string',
			length: typeof selection === 'string' ? selection.length : -1,
			value: selection,
		});
		// Coerce defensively *and* log when we have to. The 0.3.14 trace showed
		// readSelectionText returning a real string, yet the rendered modal
		// still showed "[object Object]". That can only happen if something
		// between constructor and render is replacing the value — but to make
		// this resilient regardless of root cause we keep an explicit `string`
		// field and never let a non-string into the render path.
		this.selection = typeof selection === 'string' ? selection : String(selection ?? '');
	}

	private selection: string = '';

	onOpen(): void {
		console.log('[smart-aide] EditSelectionModal.onOpen: this.selection', {
			type: typeof this.selection,
			length: typeof this.selection === 'string' ? this.selection.length : -1,
			value: this.selection,
		});

		this.titleEl.setText('Edit with AI');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vk-edit-selection-modal');
		this.contentEl.closest('.modal')?.addClass('mod-vk-narrow');

		const original = contentEl.createDiv({ cls: 'vk-edit-original' });
		original.createDiv({ cls: 'vk-modal-field-label', text: 'Selection' });
		const originalPre = original.createEl('pre', { cls: 'vk-edit-original-text' });
		// Use textContent directly rather than Obsidian's setText — avoids any
		// chance of a method override producing a stringified-object result.
		const safeSelection =
			typeof this.selection === 'string' ? this.selection : String(this.selection ?? '');
		originalPre.textContent = safeSelection;
		console.log('[smart-aide] EditSelectionModal.onOpen: rendered pre.textContent', {
			length: originalPre.textContent?.length,
			head: originalPre.textContent?.slice(0, 80),
		});

		const instr = contentEl.createDiv({ cls: 'vk-edit-instruction' });
		instr.createDiv({ cls: 'vk-modal-field-label', text: 'Instruction' });
		this.inputEl = instr.createEl('textarea', { cls: 'vk-edit-input' });
		this.inputEl.placeholder = 'Rewrite this in a more formal tone…';
		this.inputEl.rows = 2;
		this.inputEl.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
				ev.preventDefault();
				void this.submit();
			} else if (ev.key === 'Escape' && (this.state === 'idle' || this.state === 'error')) {
				this.close();
			}
		});

		this.statusEl = contentEl.createDiv({ cls: 'vk-edit-status' });
		this.diffEl = contentEl.createDiv({ cls: 'vk-edit-diff' });
		this.actionsEl = contentEl.createDiv({ cls: 'vk-modal-footer' });
		this.renderActions();

		window.setTimeout(() => this.inputEl.focus(), 0);
	}

	onClose(): void {
		this.aborter?.abort();
		this.contentEl.empty();
	}

	private setState(next: EditState): void {
		this.state = next;
		if (next === 'streaming') {
			this.statusEl.setText('Thinking…');
			this.statusEl.removeClass('vk-edit-error');
			this.diffEl.empty();
			this.inputEl.disabled = true;
		} else if (next === 'done') {
			this.statusEl.setText('');
			this.statusEl.removeClass('vk-edit-error');
			this.inputEl.disabled = true;
			if (this.rewrite !== null) this.renderDiff(this.rewrite);
		} else if (next === 'error') {
			this.statusEl.setText(this.lastError ?? 'Unknown error');
			this.statusEl.addClass('vk-edit-error');
			this.inputEl.disabled = false;
			this.diffEl.empty();
		} else {
			// idle
			this.statusEl.setText('');
			this.statusEl.removeClass('vk-edit-error');
			this.diffEl.empty();
			this.inputEl.disabled = false;
		}
		this.renderActions();
	}

	private renderActions(): void {
		this.actionsEl.empty();
		if (this.state === 'idle' || this.state === 'error') {
			const cancel = this.actionsEl.createEl('button', { text: 'Cancel' });
			cancel.addEventListener('click', () => this.close());
			this.actionsEl.createDiv({ cls: 'vk-spacer' });
			const submit = this.actionsEl.createEl('button', {
				cls: 'mod-cta',
				text: this.state === 'error' ? 'Retry' : 'Edit',
			});
			submit.addEventListener('click', () => void this.submit());
			return;
		}
		if (this.state === 'streaming') {
			this.actionsEl.createDiv({ cls: 'vk-spacer' });
			const stop = this.actionsEl.createEl('button', { text: 'Stop' });
			stop.addEventListener('click', () => this.aborter?.abort());
			return;
		}
		// done
		const reject = this.actionsEl.createEl('button', { text: 'Reject' });
		reject.addEventListener('click', () => this.close());
		this.actionsEl.createDiv({ cls: 'vk-spacer' });
		const accept = this.actionsEl.createEl('button', { cls: 'mod-cta', text: 'Accept' });
		accept.addEventListener('click', () => {
			if (this.rewrite !== null) this.onAccept(this.rewrite);
			this.close();
		});
	}

	private async submit(): Promise<void> {
		const instruction = this.inputEl.value.trim();
		if (!instruction) {
			new Notice('Enter an instruction first.');
			return;
		}
		this.lastError = null;
		this.aborter = new AbortController();
		this.setState('streaming');
		try {
			const text = await runEditRequest(this.plugin, this.selection, instruction, this.aborter.signal);
			this.rewrite = text;
			this.setState('done');
		} catch (e) {
			if (this.aborter?.signal.aborted) {
				this.setState('idle');
				return;
			}
			this.lastError = e instanceof Error ? e.message : String(e);
			this.setState('error');
		} finally {
			this.aborter = null;
		}
	}

	private renderDiff(rewrite: string): void {
		this.diffEl.empty();
		const oldLines = this.selection.split('\n');
		const newLines = rewrite.split('\n');
		const ops = lineDiff(oldLines, newLines);
		for (const op of ops) {
			const cls =
				op.type === 'add'
					? 'vk-edit-diff-line vk-diff-add'
					: op.type === 'remove'
						? 'vk-edit-diff-line vk-diff-remove'
						: 'vk-edit-diff-line vk-diff-context';
			const lineEl = this.diffEl.createDiv({ cls });
			const prefix = op.type === 'add' ? '+ ' : op.type === 'remove' ? '- ' : '  ';
			lineEl.setText(prefix + op.line);
		}
	}
}
