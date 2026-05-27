import { App, Notice, Platform, TFile, setIcon } from 'obsidian';
import { attachImageToVault, isSupportedImageMime, mimeFromExtension } from './image-helpers';
import { NotePickerModal } from './picker-notes';
import type { PinnedContext } from './context-pins';
import type { SkillRegistry, Skill } from './skills';
import type { SmartAideSettings } from './settings';
import { filterSkillsForSlash, messageText, parseSlashContext, parseUrlCandidate } from './view-helpers';
import { classifyUrl, fetchWebPage, fetchYouTube } from './url-extract';
import type { ImageBlock, MessageEntry } from './types';

export interface ComposerHost {
	readonly app: App;
	readonly settings: SmartAideSettings;
	readonly skills: SkillRegistry;
	readonly pinned: PinnedContext;
	saveSettings(): Promise<void>;
	refreshContextChips(): void;
	refreshTokenChip(): void;
	rerenderStream(): void;
	isStreaming(): boolean;
	/** True when a sync conflict or similar blocking state is active — send is
	 * refused until the user resolves it (e.g. reloads the chat). */
	isSendBlocked?(): boolean;
	/** True when the active model accepts image inputs (or we don't know — local
	 * servers often don't expose a vision flag, so undefined permits the attach
	 * and lets the provider reject if it must). */
	activeModelSupportsImages(): boolean;
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		callback: (ev: HTMLElementEventMap[K]) => unknown,
	): void;
}

/**
 * Owns the chat composer's interactive state — textarea sizing, attachment
 * chips, `@`-mention pin flow, slash autocomplete popover, and the
 * edit-and-fork banner. The view builds the DOM and forwards listener events;
 * this class holds the state and orchestrates the behavior.
 *
 * `editingFromId` and `branchFrom/branchParent` live here because send-time
 * fork resolution needs them, but the view's `send()` reads them via the
 * exposed getters rather than poking at internals.
 */
export class ComposerController {
	private pending: ImageBlock[] = [];
	private editing: string | null = null;
	private slashPopover: HTMLElement | null = null;
	private slashItems: Skill[] = [];
	private slashActiveIdx = 0;
	private slashDismisser: ((ev: MouseEvent) => void) | null = null;
	// URL paste-detect popover. Fires when the cursor sits at the end of an
	// `https?://…` token (e.g. just after a paste). Single row, async commit.
	private urlPopover: HTMLElement | null = null;
	private urlCandidate: string | null = null;
	private urlBusy = false;
	private urlError: string | null = null;
	private urlDismisser: ((ev: MouseEvent) => void) | null = null;

	constructor(
		private host: ComposerHost,
		public readonly composerEl: HTMLTextAreaElement,
		public readonly attachmentRowEl: HTMLDivElement,
		public readonly sendBtn: HTMLButtonElement,
	) {}

	// ---------- accessors ----------

	get pendingImages(): ImageBlock[] {
		return this.pending;
	}

	get editingFromId(): string | null {
		return this.editing;
	}

	get branchFrom(): string | undefined {
		return this.composerEl.dataset.branchFrom;
	}

	get branchParent(): string | undefined {
		return this.composerEl.dataset.branchParent;
	}

	// ---------- send-flow helpers used by view.send() ----------

	consumePendingImages(): ImageBlock[] {
		const snapshot = this.pending;
		this.pending = [];
		return snapshot;
	}

	clearComposerValue(): void {
		this.composerEl.value = '';
	}

	clearBranchMarkers(): void {
		delete this.composerEl.dataset.branchFrom;
		delete this.composerEl.dataset.branchParent;
		this.editing = null;
	}

	// ---------- composer ops ----------

	autosize(): void {
		this.composerEl.style.height = 'auto';
		const min = 72;
		const max = 240;
		const next = Math.min(max, Math.max(min, this.composerEl.scrollHeight));
		this.composerEl.style.height = next + 'px';
	}

	refreshSendState(): void {
		const empty = this.composerEl.value.trim().length === 0 && this.pending.length === 0;
		const blocked = this.host.isSendBlocked?.() ?? false;
		this.sendBtn.disabled = empty || this.host.isStreaming() || blocked;
	}

	insertAtCursor(text: string): void {
		const value = this.composerEl.value;
		const start = this.composerEl.selectionStart ?? value.length;
		const end = this.composerEl.selectionEnd ?? start;
		this.composerEl.value = value.slice(0, start) + text + value.slice(end);
		const newCursor = start + text.length;
		this.composerEl.setSelectionRange(newCursor, newCursor);
		this.composerEl.focus();
		this.autosize();
		this.refreshSendState();
	}

	// ---------- attachments ----------

	async handleDroppedFiles(files: FileList): Promise<void> {
		if (!this.host.activeModelSupportsImages()) {
			new Notice("This model doesn't accept images. Pick a vision-capable model to attach.");
			return;
		}
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			if (!f.type.startsWith('image/')) {
				new Notice(`Skipped non-image: ${f.name}`);
				continue;
			}
			if (!isSupportedImageMime(f.type)) {
				new Notice(`${f.type} isn't supported. Use JPEG, PNG, GIF, or WebP.`);
				continue;
			}
			try {
				const buf = await f.arrayBuffer();
				const block = await attachImageToVault(this.host.app, buf, f.name, f.type);
				this.pending.push(block);
			} catch (e) {
				new Notice(`Could not attach ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.refreshAttachmentChips();
		this.refreshSendState();
	}

	async attachVaultImage(path: string): Promise<void> {
		if (!this.host.activeModelSupportsImages()) {
			new Notice("This model doesn't accept images. Pick a vision-capable model to attach.");
			return;
		}
		const file = this.host.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(`Not found: ${path}`);
			return;
		}
		const mime = mimeFromExtension(path);
		if (!isSupportedImageMime(mime)) {
			new Notice(`${mime} isn't supported. Use JPEG, PNG, GIF, or WebP.`);
			return;
		}
		this.pending.push({ type: 'image', path, mime });
		this.refreshAttachmentChips();
		this.refreshSendState();
	}

	refreshAttachmentChips(): void {
		this.attachmentRowEl.empty();
		if (this.pending.length === 0) {
			this.attachmentRowEl.hide();
			return;
		}
		this.attachmentRowEl.show();
		for (let i = 0; i < this.pending.length; i++) {
			const block = this.pending[i];
			const chip = this.attachmentRowEl.createDiv({ cls: 'vk-attachment-chip' });
			const file = this.host.app.vault.getFileByPath(block.path);
			if (file) {
				const img = chip.createEl('img', { cls: 'vk-attachment-thumb' });
				img.src = this.host.app.vault.getResourcePath(file);
			}
			chip.createSpan({ cls: 'vk-attachment-name', text: block.path.split('/').pop() ?? block.path });
			const removeBtn = chip.createEl('button', {
				cls: 'vk-icon-btn vk-attachment-remove',
				attr: { type: 'button' },
			});
			setIcon(removeBtn, 'x');
			removeBtn.setAttribute('aria-label', 'Remove attachment');
			const idx = i;
			this.host.registerDomEvent(removeBtn, 'click', () => {
				this.pending.splice(idx, 1);
				this.refreshAttachmentChips();
				this.refreshSendState();
			});
		}
	}

	// ---------- vault path pin (drag-drop) ----------

	tryPinVaultPath(data: string): boolean {
		if (data.startsWith('[[')) return false;
		const looksLikeMd = data.endsWith('.md');
		const file = this.host.app.vault.getFileByPath(data);
		if (!looksLikeMd && !file) return false;
		const path = file ? file.path : data;
		if (!this.host.app.vault.getFileByPath(path)) return false;
		this.host.pinned.add(path);
		this.host.refreshContextChips();
		return true;
	}

	// ---------- @ mention ----------

	openNoteMentionPicker(): void {
		new NotePickerModal(this.host.app, (file) => this.pinViaMention(file)).open();
		void this.maybeShowMentionTip();
	}

	private pinViaMention(file: TFile): void {
		const value = this.composerEl.value;
		const cursor = this.composerEl.selectionStart ?? value.length;
		const lookback = value.slice(Math.max(0, cursor - 40), cursor);
		const atMatch = lookback.match(/@[^\s]*$/);
		if (atMatch) {
			const atStart = cursor - atMatch[0].length;
			const before = value.slice(0, atStart);
			const after = value.slice(cursor);
			this.composerEl.value = before + after;
			this.composerEl.setSelectionRange(before.length, before.length);
		}
		this.host.pinned.add(file.path);
		this.host.refreshContextChips();
		this.composerEl.focus();
		this.autosize();
		this.refreshSendState();
	}

	private async maybeShowMentionTip(): Promise<void> {
		if (this.host.settings.hasSeenMentionTip) return;
		this.host.settings.hasSeenMentionTip = true;
		await this.host.saveSettings();
		new Notice('@ now pins a note as context. Use [[ for an inline link.', 6000);
	}

	// ---------- slash autocomplete ----------

	isSlashOpen(): boolean {
		return this.slashPopover !== null;
	}

	updateSlashPopover(): void {
		const query = parseSlashContext(this.composerEl.value);
		if (query === null) {
			this.closeSlashPopover();
			return;
		}
		const all = this.host.skills.userInvocableSkills();
		if (all.length === 0) {
			this.closeSlashPopover();
			return;
		}
		const max = Platform.isMobile ? 4 : 5;
		const items = filterSkillsForSlash(all, query, max);
		if (items.length === 0) {
			this.closeSlashPopover();
			return;
		}
		this.slashItems = items;
		if (this.slashActiveIdx >= items.length) this.slashActiveIdx = 0;
		if (!this.slashPopover) this.mountSlashPopover();
		this.renderSlashPopover();
	}

	private mountSlashPopover(): void {
		const composerWrap = this.composerEl.closest('.vk-composer') as HTMLElement | null;
		if (!composerWrap) return;
		this.slashPopover = composerWrap.createDiv({ cls: 'vk-slash-popover' });
		this.slashActiveIdx = 0;

		this.slashDismisser = (ev: MouseEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (this.slashPopover?.contains(target)) return;
			if (this.composerEl.contains(target)) return;
			this.closeSlashPopover();
		};
		// Defer attachment one tick so the click that may have caused this open
		// doesn't immediately close it.
		window.setTimeout(() => {
			if (this.slashDismisser) document.addEventListener('click', this.slashDismisser);
		}, 0);
	}

	closeSlashPopover(): void {
		if (this.slashDismisser) {
			document.removeEventListener('click', this.slashDismisser);
			this.slashDismisser = null;
		}
		this.slashPopover?.remove();
		this.slashPopover = null;
		this.slashItems = [];
		this.slashActiveIdx = 0;
	}

	private renderSlashPopover(): void {
		if (!this.slashPopover) return;
		this.slashPopover.empty();
		for (let i = 0; i < this.slashItems.length; i++) {
			const skill = this.slashItems[i];
			const item = this.slashPopover.createDiv({
				cls: 'vk-slash-item' + (i === this.slashActiveIdx ? ' is-active' : ''),
			});
			item.createDiv({ cls: 'vk-slash-name', text: `/${skill.name}` });
			item.createDiv({ cls: 'vk-slash-desc', text: skill.description });
			const idx = i;
			// mousedown (not click) so the textarea doesn't blur before we commit;
			// preventDefault keeps focus + the on-screen keyboard from dismissing on iOS.
			this.host.registerDomEvent(item, 'mousedown', (ev: MouseEvent) => {
				ev.preventDefault();
				this.commitSlashSelection(this.slashItems[idx]);
			});
			this.host.registerDomEvent(item, 'mouseenter', () => {
				if (this.slashActiveIdx !== idx) {
					this.slashActiveIdx = idx;
					this.refreshSlashHighlight();
				}
			});
		}
	}

	private refreshSlashHighlight(): void {
		if (!this.slashPopover) return;
		const els = this.slashPopover.querySelectorAll('.vk-slash-item');
		els.forEach((el, i) => el.toggleClass('is-active', i === this.slashActiveIdx));
		els[this.slashActiveIdx]?.scrollIntoView({ block: 'nearest' });
	}

	private setSlashActiveIdx(idx: number): void {
		const len = this.slashItems.length;
		if (len === 0) return;
		this.slashActiveIdx = ((idx % len) + len) % len;
		this.refreshSlashHighlight();
	}

	private commitSlashSelection(skill: Skill): void {
		this.composerEl.value = `/${skill.name} `;
		const end = this.composerEl.value.length;
		this.composerEl.setSelectionRange(end, end);
		this.composerEl.focus();
		this.autosize();
		this.refreshSendState();
		this.closeSlashPopover();
	}

	handleSlashPopoverKey(ev: KeyboardEvent): boolean {
		if (ev.isComposing) return false;
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.setSlashActiveIdx(this.slashActiveIdx + 1);
			return true;
		}
		if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.setSlashActiveIdx(this.slashActiveIdx - 1);
			return true;
		}
		if (ev.key === 'Enter' || ev.key === 'Tab') {
			if (this.slashItems.length === 0) return false;
			ev.preventDefault();
			this.commitSlashSelection(this.slashItems[this.slashActiveIdx]);
			return true;
		}
		if (ev.key === 'Escape') {
			ev.preventDefault();
			this.closeSlashPopover();
			return true;
		}
		return false;
	}

	// ---------- URL paste-detect popover ----------

	isUrlPopoverOpen(): boolean {
		return this.urlPopover !== null;
	}

	/**
	 * Recompute whether the cursor is currently at the end of a URL token.
	 * Two callsites:
	 *   - on paste (allowOpen=true): paste-detect that opens the popover.
	 *   - on input (allowOpen=false): updates / dismisses an already-open popover
	 *     as the user keeps typing past the URL. Crucially does NOT open a new
	 *     popover for URLs being typed character-by-character — that fires on
	 *     every keystroke and surprised users with premature fetches of
	 *     half-typed URLs.
	 */
	updateUrlPopover(allowOpen = false): void {
		if (this.urlBusy) return;
		const candidate = parseUrlCandidate(this.composerEl.value, this.composerEl.selectionStart ?? this.composerEl.value.length);
		if (!candidate) {
			this.closeUrlPopover();
			return;
		}
		if (classifyUrl(candidate).kind === 'unknown') {
			this.closeUrlPopover();
			return;
		}
		if (!this.urlPopover && !allowOpen) return;
		this.urlCandidate = candidate;
		this.urlError = null;
		// Slash and URL popovers are mutually exclusive by their patterns
		// (slash requires `/<name>` with no terminator), but close defensively
		// so a stale slash popover doesn't overlap.
		this.closeSlashPopover();
		if (!this.urlPopover) this.mountUrlPopover();
		this.renderUrlPopover();
	}

	private mountUrlPopover(): void {
		const composerWrap = this.composerEl.closest('.vk-composer') as HTMLElement | null;
		if (!composerWrap) return;
		this.urlPopover = composerWrap.createDiv({ cls: 'vk-url-popover' });

		this.urlDismisser = (ev: MouseEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (this.urlPopover?.contains(target)) return;
			if (this.composerEl.contains(target)) return;
			this.closeUrlPopover();
		};
		window.setTimeout(() => {
			if (this.urlDismisser) document.addEventListener('click', this.urlDismisser);
		}, 0);
	}

	closeUrlPopover(): void {
		if (this.urlDismisser) {
			document.removeEventListener('click', this.urlDismisser);
			this.urlDismisser = null;
		}
		this.urlPopover?.remove();
		this.urlPopover = null;
		this.urlCandidate = null;
		this.urlBusy = false;
		this.urlError = null;
	}

	private renderUrlPopover(): void {
		if (!this.urlPopover || !this.urlCandidate) return;
		this.urlPopover.empty();
		const row = this.urlPopover.createDiv({ cls: 'vk-url-row' + (this.urlError ? ' is-error' : '') });
		const icon = row.createSpan({ cls: 'vk-url-icon' });
		const kind = classifyUrl(this.urlCandidate).kind;
		setIcon(icon, kind === 'youtube' ? 'play-circle' : 'link');

		const body = row.createDiv({ cls: 'vk-url-body' });
		if (this.urlError) {
			body.createDiv({ cls: 'vk-url-label', text: this.urlError });
			body.createDiv({ cls: 'vk-url-target', text: this.urlCandidate });
		} else if (this.urlBusy) {
			body.createDiv({ cls: 'vk-url-label', text: kind === 'youtube' ? 'Fetching transcript…' : 'Fetching page…' });
			body.createDiv({ cls: 'vk-url-target', text: this.urlCandidate });
		} else {
			body.createDiv({ cls: 'vk-url-label', text: kind === 'youtube' ? 'Pin YouTube transcript' : 'Pin web page' });
			body.createDiv({ cls: 'vk-url-target', text: this.urlCandidate });
		}

		if (!this.urlBusy && !this.urlError) {
			// mousedown (not click) so the textarea doesn't blur before we commit;
			// preventDefault keeps focus + the on-screen keyboard up on iOS.
			this.host.registerDomEvent(row, 'mousedown', (ev: MouseEvent) => {
				ev.preventDefault();
				void this.commitUrlPin();
			});
		}
	}

	async commitUrlPin(): Promise<void> {
		const candidate = this.urlCandidate;
		if (!candidate || this.urlBusy) return;
		this.urlError = null;
		this.urlBusy = true;
		this.renderUrlPopover();
		try {
			const { kind, normalized } = classifyUrl(candidate);
			if (this.host.pinned.has(normalized)) {
				new Notice('That URL is already pinned.');
				this.stripUrlFromComposer(candidate);
				this.closeUrlPopover();
				return;
			}
			if (kind === 'youtube') {
				const extract = await fetchYouTube(normalized);
				this.host.pinned.addYouTube(extract);
			} else if (kind === 'web') {
				const extract = await fetchWebPage(normalized);
				this.host.pinned.addUrl(extract);
			} else {
				throw new Error('Unsupported URL scheme');
			}
			this.stripUrlFromComposer(candidate);
			this.host.refreshContextChips();
			this.closeUrlPopover();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.urlError = msg;
			this.urlBusy = false;
			this.renderUrlPopover();
		}
	}

	/**
	 * Remove the URL token (plus one trailing space, if any) from the textarea
	 * so the user's prose doesn't carry a now-redundant URL string. Cursor
	 * lands where the URL used to start.
	 */
	private stripUrlFromComposer(candidate: string): void {
		const value = this.composerEl.value;
		const cursor = this.composerEl.selectionStart ?? value.length;
		const start = cursor - candidate.length;
		if (start < 0 || value.slice(start, cursor) !== candidate) return;
		// Also eat a single trailing space if we'd otherwise leave " " at the cut.
		let end = cursor;
		if (value[end] === ' ') end += 1;
		// And eat a leading space if the URL was preceded by one and now sits
		// next to other whitespace (so we don't leave a double space).
		let cutStart = start;
		if (cutStart > 0 && value[cutStart - 1] === ' ' && value[end] === ' ') cutStart -= 1;
		this.composerEl.value = value.slice(0, cutStart) + value.slice(end);
		this.composerEl.setSelectionRange(cutStart, cutStart);
		this.autosize();
		this.refreshSendState();
	}

	/**
	 * Keyboard handling while the URL popover is open. Tab commits (matches
	 * the slash popover pattern), Esc dismisses (leaves the URL in the
	 * textarea so the user keeps their work). Enter deliberately falls
	 * through so it sends the message / inserts a newline — committing on
	 * Enter accidentally fetched half-typed URLs.
	 */
	handleUrlPopoverKey(ev: KeyboardEvent): boolean {
		if (ev.isComposing) return false;
		if (ev.key === 'Tab') {
			if (this.urlBusy) {
				ev.preventDefault();
				return true;
			}
			ev.preventDefault();
			void this.commitUrlPin();
			return true;
		}
		if (ev.key === 'Escape') {
			ev.preventDefault();
			this.closeUrlPopover();
			return true;
		}
		return false;
	}

	// ---------- edit-fork ----------

	startEditBranch(parentEntry: MessageEntry): void {
		this.composerEl.value = messageText(parentEntry.message);
		this.composerEl.dataset.branchParent = parentEntry.parentId ?? '';
		this.composerEl.dataset.branchFrom = parentEntry.id;
		this.autosize();
		this.refreshSendState();
		this.composerEl.focus();
		this.showEditBanner();
		this.editing = parentEntry.id;
		this.host.rerenderStream();
	}

	cancelEdit(): void {
		delete this.composerEl.dataset.branchFrom;
		delete this.composerEl.dataset.branchParent;
		this.composerEl.value = '';
		this.autosize();
		this.refreshSendState();
		this.removeEditBanner();
		if (this.editing) {
			this.editing = null;
			this.host.rerenderStream();
		}
	}

	finishEditBranch(): void {
		// Called by view.send() once the fork has been committed — clears banner
		// without triggering a rerender (send already rerenders).
		this.removeEditBanner();
		this.editing = null;
		delete this.composerEl.dataset.branchFrom;
		delete this.composerEl.dataset.branchParent;
	}

	private showEditBanner(): void {
		this.removeEditBanner();
		const wrap = this.composerEl.parentElement;
		if (!wrap) return;
		const banner = wrap.createDiv({ cls: 'vk-edit-banner' });
		banner.createSpan({ cls: 'vk-edit-banner-text', text: 'Editing — Send to fork from this message' });
		const cancel = banner.createEl('button', { cls: 'vk-edit-banner-cancel', text: 'Cancel' });
		this.host.registerDomEvent(cancel, 'click', () => this.cancelEdit());
		wrap.insertBefore(banner, this.composerEl);
	}

	private removeEditBanner(): void {
		const wrap = this.composerEl?.parentElement;
		if (!wrap) return;
		const existing = wrap.querySelector('.vk-edit-banner');
		if (existing) existing.remove();
	}
}
