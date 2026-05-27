import { App, Modal, Notice, Platform, setIcon } from 'obsidian';
import { runEditRequest, type EditRequestInput } from './edit-selection';
import { lineDiff } from './view-helpers';
import { describeModelRef, resolveModelRefStrict } from './settings';
import { FavoritesPickerModal, BrowseAllPickerModal } from './picker-models';
import { friendlyModelName } from './models';
import type SmartAidePlugin from './main';
import type { ModelRef } from './types';

type EditState = 'idle' | 'streaming' | 'done' | 'error';

/**
 * Inline edit modal. Captures the user's instruction, calls the chat model
 * once (with the surrounding document, AGENTS.md, and memory.md as context),
 * shows the proposed rewrite as a unified diff, and (on Accept) hands the
 * rewrite back to the caller for `editor.replaceSelection`.
 *
 * State machine:
 *   idle      → prompt input visible, focus
 *   streaming → input locked, "Thinking…" status, Stop button (AbortController)
 *   done      → diff visible, Accept / Reject buttons
 *   error     → error message, input unlocked, Retry button
 *
 * The edit model defaults to the chat model but is overridable per-modal
 * via the model chip in the action bar.
 *
 * IMPORTANT: do not name the selection field `selection` — Obsidian's
 * Modal base class has its own `selection: Selection` property and
 * overwrites ours before `onOpen` runs.
 */
export class EditSelectionModal extends Modal {
	private inputEl!: HTMLTextAreaElement;
	private statusEl!: HTMLElement;
	private diffEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private modelChipEl!: HTMLButtonElement;

	private state: EditState = 'idle';
	private rewrite: string | null = null;
	private aborter: AbortController | null = null;
	private lastError: string | null = null;
	private originalText: string;
	private modelRef: ModelRef;

	constructor(
		app: App,
		private plugin: SmartAidePlugin,
		private input: Omit<EditRequestInput, 'instruction'>,
		private onAccept: (newText: string) => void,
	) {
		super(app);
		this.originalText = input.selection;
		this.modelRef = { ...plugin.settings.defaultModelRef };
	}

	onOpen(): void {
		this.titleEl.setText('Edit with AI');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vk-edit-selection-modal');
		this.contentEl.closest('.modal')?.addClass('mod-vk-narrow');

		const original = contentEl.createDiv({ cls: 'vk-edit-original' });
		original.createDiv({ cls: 'vk-modal-field-label', text: 'Selection' });
		const originalPre = original.createEl('pre', { cls: 'vk-edit-original-text' });
		originalPre.textContent = this.originalText;

		const instr = contentEl.createDiv({ cls: 'vk-edit-instruction' });
		instr.createDiv({ cls: 'vk-modal-field-label', text: 'Instruction' });
		this.inputEl = instr.createEl('textarea', { cls: 'vk-edit-input' });
		this.inputEl.placeholder = 'Rewrite this in a more formal tone…';
		this.inputEl.rows = 2;
		this.inputEl.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' && !ev.isComposing) {
				const desktopSubmit = ev.metaKey || ev.ctrlKey;
				const mobileSubmit = Platform.isMobile && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey;
				if (desktopSubmit || mobileSubmit) {
					ev.preventDefault();
					void this.submit();
					return;
				}
			}
			if (ev.key === 'Escape' && (this.state === 'idle' || this.state === 'error')) {
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
			this.inputEl.blur();
		} else if (next === 'done') {
			this.statusEl.setText('');
			this.statusEl.removeClass('vk-edit-error');
			this.inputEl.disabled = true;
			this.inputEl.blur();
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
		// Model chip — always visible. Click to change which model runs the edit.
		this.modelChipEl = this.actionsEl.createEl('button', {
			cls: 'vk-edit-model-chip',
			attr: { type: 'button' },
		});
		this.refreshModelChip();
		this.modelChipEl.addEventListener('click', () => this.openModelPicker());
		this.modelChipEl.disabled = this.state === 'streaming';

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

	private refreshModelChip(): void {
		this.modelChipEl.empty();
		const icon = this.modelChipEl.createSpan({ cls: 'vk-edit-model-chip-icon' });
		setIcon(icon, 'sparkles');
		this.modelChipEl.createSpan({
			cls: 'vk-edit-model-chip-label',
			text: friendlyModelName(this.modelRef.slug),
		});
		this.modelChipEl.title = describeModelRef(this.plugin.settings, this.modelRef);
	}

	private openModelPicker(): void {
		const settings = this.plugin.settings;
		const pick = (ref: ModelRef) => {
			this.modelRef = ref;
			this.refreshModelChip();
		};
		new FavoritesPickerModal(
			this.app,
			settings.endpoints,
			this.modelRef,
			settings.favoriteModels,
			pick,
			() => {
				new BrowseAllPickerModal(
					this.app,
					settings.endpoints,
					this.modelRef,
					settings.favoriteModels,
					{
						onPick: pick,
						// Favorites are managed in settings; not toggling them from
						// inside the edit modal keeps responsibilities separate.
						onToggleFavorite: () => undefined,
					},
				).open();
			},
		).open();
	}

	private async submit(): Promise<void> {
		const instruction = this.inputEl.value.trim();
		if (!instruction) {
			new Notice('Enter an instruction first.');
			return;
		}
		if (!resolveModelRefStrict(this.plugin.settings, this.modelRef)) {
			new Notice('That endpoint was removed. Pick another model.');
			this.openModelPicker();
			return;
		}
		this.lastError = null;
		this.aborter = new AbortController();
		this.setState('streaming');
		try {
			const text = await runEditRequest(
				this.plugin,
				this.modelRef,
				{ ...this.input, instruction },
				this.aborter.signal,
			);
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
		const oldLines = this.originalText.split('\n');
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
