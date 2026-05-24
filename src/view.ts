import { ItemView, MarkdownRenderChild, MarkdownRenderer, Notice, Platform, TFile, WorkspaceLeaf, parseLinktext, setIcon } from 'obsidian';
import { LOAD_SKILL_NAME, LOAD_SKILL_TOOL_DEF, TOOLS, toolsToDescriptors } from './tools';
import { providerFor } from './providers';
import type { ToolCall } from './providers';
import { ChatSession } from './storage';
import { bumpRecent, friendlyModelName } from './models';
import { ModelPickerModal } from './picker-models';
import { NotePickerModal } from './picker-notes';
import { SkillPickerModal } from './picker-skills';
import type { Skill } from './skills';
import { RenameChatModal } from './modal-rename-chat';
import { PinnedContext } from './context-pins';
import { findEndpoint, resolveModelRef } from './settings';
import {
	Burst,
	TokenBreakdown,
	estimateTokens,
	filterTools,
	formatCostUsd,
	formatTokenChip,
	formatTokens,
	formatUsageTooltip,
	groupChainIntoBursts,
	messageText,
	parseSlashInvocation,
	safeParse,
	sumBreakdown,
} from './view-helpers';
import { ApprovalDecision, BatchApprovalItem, requestApproval, requestBatchedWriteApprovals } from './view-approval';
import {
	addCopyButtons,
	renderCitationCard,
	renderImageBlock,
	renderResearchChip,
	renderToolCallBlock,
	renderToolResultBlock,
} from './view-render';
import { maybeAutoTitle } from './view-autotitle';
import {
	AgentMessage,
	ContentBlock,
	ImageBlock,
	MessageEntry,
	ModelRef,
} from './types';
import { attachImageToVault, isSupportedImageMime, mimeFromExtension } from './image-helpers';
import type SmartAidePlugin from './main';

export const CHAT_VIEW_TYPE = 'smart-aide-chat-view';

const MAX_TOOL_TURNS = 8;

export class ChatView extends ItemView {
	private plugin: SmartAidePlugin;
	private session: ChatSession | null = null;
	private modelRef: ModelRef;
	private abort: AbortController | null = null;
	private approveAllInTurn = false;
	private turnUsageByEntry: Map<string, TurnUsage> = new Map();
	private loadedSkills: string[] = [];
	private editingFromId: string | null = null;
	private pinned: PinnedContext;

	// DOM refs
	private titleBtn!: HTMLButtonElement;
	private modelChip!: HTMLButtonElement;
	private tokenChip!: HTMLButtonElement;
	private tokenPopover: HTMLElement | null = null;
	private tokenPopoverDismisser: ((ev: MouseEvent) => void) | null = null;
	private stopBtn!: HTMLButtonElement;
	private streamEl!: HTMLDivElement;
	private contextRowEl!: HTMLDivElement;
	private composerEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private dangerChip: HTMLButtonElement | null = null;
	private attachmentRowEl!: HTMLDivElement;
	private pendingImages: ImageBlock[] = [];
	private cumulativeTokens = { prompt: 0, completion: 0, cached: 0 };
	/** Token breakdown cache invalidated when pins/skills/history/model change. */
	private cachedBreakdown: TokenBreakdown | null = null;
	// MarkdownRenderChild instances spawned by the current stream render. Unloaded
	// before each rerender so long chats don't leak children/event handlers.
	private streamRenderChildren: MarkdownRenderChild[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: SmartAidePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.modelRef = plugin.settings.defaultModelRef;
		this.pinned = new PinnedContext(plugin.app);
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Smart Aide';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen(): Promise<void> {
		this.render();
		if (!this.session) {
			await this.newChat();
		}
	}

	async onClose(): Promise<void> {
		this.abort?.abort();
		this.closeTokenPopover();
	}

	async newChat(): Promise<void> {
		this.abort?.abort();
		this.session = await this.plugin.storage.createChat();
		this.cumulativeTokens = { prompt: 0, completion: 0, cached: 0 };
		this.pinned.clear();
		this.autoPinActive();
		// Queue the initial model_change in memory only — it'll be persisted alongside
		// the first user message so empty new chats don't litter the picker.
		const modelEntry = this.plugin.storage.makeModelChangeEntry(
			this.modelRef.endpointId,
			this.modelRef.slug,
			null,
		);
		this.session.entries.push(modelEntry);
		this.session.leafId = modelEntry.id;
		this.rerenderStream();
		this.invalidateBreakdownCache();
		void this.refreshTokenChip();
		this.updateTabTitle();
	}

	async loadChat(path: string): Promise<void> {
		this.abort?.abort();
		this.session = await this.plugin.storage.loadChat(path);
		// Walk the active branch (leaf → root) so a model_change on a dead branch
		// can't become the visible model. contextChain returns chronological order.
		const chain = this.plugin.storage.contextChain(this.session);
		for (let i = chain.length - 1; i >= 0; i--) {
			const e = chain[i];
			if (e.type === 'model_change') {
				this.modelRef = { endpointId: e.provider, slug: e.modelId };
				if (this.modelChip) this.refreshModelChip();
				break;
			}
		}
		this.cumulativeTokens = { prompt: 0, completion: 0, cached: 0 };
		this.pinned.clear();
		this.autoPinActive();
		this.rerenderStream();
		this.invalidateBreakdownCache();
		void this.refreshTokenChip();
		this.updateTabTitle();
	}

	private render(): void {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass('vk-root');

		// Top bar: chat title (click → switch chats, long-press / right-click → rename) + new-chat icon.
		const topbar = root.createDiv({ cls: 'vk-topbar' });

		this.titleBtn = topbar.createEl('button', { cls: 'vk-topbar-title' });
		this.titleBtn.setAttribute('aria-label', 'Current chat — tap to switch, long-press to rename');
		this.titleBtn.title = 'Switch chats · long-press to rename';
		this.refreshTopbarTitle();
		this.registerDomEvent(this.titleBtn, 'click', () => void this.plugin.openChatPicker());
		this.registerDomEvent(this.titleBtn, 'contextmenu', (ev: MouseEvent) => {
			ev.preventDefault();
			this.openRenameModal();
		});
		let longPressTimer: number | undefined;
		const cancelLongPress = () => {
			if (longPressTimer !== undefined) {
				window.clearTimeout(longPressTimer);
				longPressTimer = undefined;
			}
		};
		this.registerDomEvent(this.titleBtn, 'pointerdown', () => {
			cancelLongPress();
			longPressTimer = window.setTimeout(() => {
				longPressTimer = undefined;
				this.openRenameModal();
			}, 600);
		});
		this.registerDomEvent(this.titleBtn, 'pointerup', cancelLongPress);
		this.registerDomEvent(this.titleBtn, 'pointerleave', cancelLongPress);
		this.registerDomEvent(this.titleBtn, 'pointercancel', cancelLongPress);

		topbar.createDiv({ cls: 'vk-spacer' });

		this.dangerChip = topbar.createEl('button', {
			cls: 'vk-danger-chip',
			attr: { type: 'button' },
		});
		this.dangerChip.createSpan({ cls: 'vk-danger-chip-icon', text: '⚠' });
		this.dangerChip.createSpan({ cls: 'vk-danger-chip-text', text: 'auto-approve' });
		this.dangerChip.title = 'Writes are auto-approved without a diff. Click to open settings.';
		this.dangerChip.setAttribute('aria-label', 'Auto-approve writes is on. Click to open settings.');
		this.registerDomEvent(this.dangerChip, 'click', () => this.openPluginSettings());
		this.refreshDangerChip();

		const newBtn = topbar.createEl('button', { cls: 'vk-icon-btn vk-topbar-btn' });
		setIcon(newBtn, 'plus');
		newBtn.setAttribute('aria-label', 'New chat');
		newBtn.title = 'New chat';
		this.registerDomEvent(newBtn, 'click', () => void this.newChat());

		// Message stream (takes all available vertical space)
		this.streamEl = root.createDiv({ cls: 'vk-stream' });

		// Delegate link clicks. MarkdownRenderer produces .internal-link / .external-link
		// elements but doesn't auto-wire navigation in a custom ItemView context — we do it.
		// Internal links MUST open in the main area (rootSplit), not in our sidebar pane.
		this.registerDomEvent(this.streamEl, 'click', (ev: MouseEvent) => {
			const target = ev.target as HTMLElement | null;
			if (!target) return;
			const internal = target.closest('a.internal-link') as HTMLAnchorElement | null;
			if (internal) {
				ev.preventDefault();
				const href = internal.getAttribute('data-href') || internal.getAttribute('href') || '';
				const inNewTab = ev.metaKey || ev.ctrlKey || ev.button === 1;
				void this.openInternalLink(href, inNewTab);
				return;
			}
			const external = target.closest('a.external-link') as HTMLAnchorElement | null;
			if (external) {
				const href = external.getAttribute('href');
				if (href) {
					ev.preventDefault();
					window.open(href, '_blank');
				}
			}
		});

		// Composer (sticky bottom, holds textarea + toolbar)
		const composerWrap = root.createDiv({ cls: 'vk-composer' });

		// Single bordered card that visually unifies pills, textarea, and toolbar —
		// the pinned context appears *inside* the input box (Copilot/Smart Compose
		// style), not floating above it.
		const inputWrap = composerWrap.createDiv({ cls: 'vk-input-wrap' });

		// Pinned-context chip row — sits at the top of the input card.
		// Shows files pinned for this chat; content is injected into each user
		// turn as a preamble.
		this.contextRowEl = inputWrap.createDiv({ cls: 'vk-context-row' });
		this.refreshContextChips();

		// Drop a vault note onto the context strip → pin it (mirrors @-mention).
		this.registerDomEvent(this.contextRowEl, 'dragover', (ev: DragEvent) => {
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
			ev.preventDefault();
		});
		this.registerDomEvent(this.contextRowEl, 'drop', (ev: DragEvent) => {
			const data = ev.dataTransfer?.getData('text/plain') || '';
			if (!data) return;
			ev.preventDefault();
			this.tryPinVaultPath(data);
		});

		// Pending image attachments for the next send — chips with thumbnail + remove.
		this.attachmentRowEl = inputWrap.createDiv({ cls: 'vk-attachment-row' });
		this.refreshAttachmentChips();

		this.composerEl = inputWrap.createEl('textarea', {
			cls: 'vk-input',
			placeholder: 'Ask anything about your vault…',
		});
		this.composerEl.rows = 3;
		this.registerDomEvent(this.composerEl, 'keydown', (ev: KeyboardEvent) => {
			if (ev.key === '@' && !ev.isComposing) {
				// Let the @ get typed; open the picker on next tick so cursor is past the @
				window.setTimeout(() => this.openNoteMentionPicker(), 0);
				return;
			}
			if (ev.key === '/' && !ev.isComposing && this.composerEl.value === '') {
				// Slash at the start of an empty composer opens the user-invocable skill picker.
				const skills = this.plugin.skills.userInvocableSkills();
				if (skills.length === 0) return;
				window.setTimeout(() => this.openSkillPicker(skills), 0);
				return;
			}
			if (ev.key !== 'Enter') return;
			if (ev.isComposing) return; // IME composition — never intercept
			if (Platform.isMobile) return; // mobile keyboard Enter inserts newline; tap Send to send
			ev.preventDefault();
			void this.send();
		});
		this.registerDomEvent(this.composerEl, 'input', () => this.autosizeComposer());
		this.registerDomEvent(this.composerEl, 'input', () => this.updateSendState());
		this.registerDomEvent(this.composerEl, 'input', () => void this.refreshTokenChip());

		// Drag-drop: vault wikilink OR a file (image) from Finder/Explorer / vault attachment
		this.registerDomEvent(this.composerEl, 'dragover', (ev: DragEvent) => {
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
			ev.preventDefault();
		});
		this.registerDomEvent(this.composerEl, 'drop', (ev: DragEvent) => {
			// File drop wins over text drop — Finder/Explorer set dataTransfer.files.
			const files = ev.dataTransfer?.files;
			if (files && files.length > 0) {
				ev.preventDefault();
				void this.handleDroppedFiles(files);
				return;
			}
			const data = ev.dataTransfer?.getData('text/plain') || '';
			if (!data) return;
			ev.preventDefault();
			// Vault attachment drag drops the path as text/plain. Image path →
			// attach. Vault .md path → pin (matches @ semantics). Other text →
			// insert as-is for free-form mentions.
			const looksLikeImage = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(data);
			if (looksLikeImage) {
				void this.attachVaultImage(data);
				return;
			}
			if (this.tryPinVaultPath(data)) return;
			this.insertAtCursor(data);
		});

		// Paste handler: any image on the clipboard becomes an attachment.
		this.registerDomEvent(this.composerEl, 'paste', (ev: ClipboardEvent) => {
			const items = ev.clipboardData?.items;
			if (!items) return;
			const images: File[] = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.kind === 'file' && item.type.startsWith('image/')) {
					const f = item.getAsFile();
					if (f) images.push(f);
				}
			}
			if (images.length === 0) return;
			ev.preventDefault();
			void this.handleDroppedFiles(images as unknown as FileList);
		});

		// Toolbar beneath the textarea: model picker | tokens | spacer | attach | camera | stop | send
		const toolbar = inputWrap.createDiv({ cls: 'vk-toolbar' });

		this.modelChip = toolbar.createEl('button', { cls: 'vk-model-chip', attr: { type: 'button' } });
		this.refreshModelChip();
		this.registerDomEvent(this.modelChip, 'click', () => this.openModelPicker());

		this.tokenChip = toolbar.createEl('button', {
			cls: 'vk-token-chip',
			attr: { type: 'button' },
		});
		this.tokenChip.setAttribute('aria-label', 'Context usage. Click for breakdown.');
		this.registerDomEvent(this.tokenChip, 'click', () => this.toggleTokenPopover());

		toolbar.createDiv({ cls: 'vk-spacer' });

		// File picker button (paperclip). Works desktop + mobile.
		const attachBtn = toolbar.createEl('button', { cls: 'vk-icon-btn vk-attach', attr: { type: 'button' } });
		setIcon(attachBtn, 'paperclip');
		attachBtn.setAttribute('aria-label', 'Attach image');
		const filePicker = composerWrap.createEl('input', {
			cls: 'vk-hidden',
			type: 'file',
			attr: { accept: 'image/jpeg,image/png,image/gif,image/webp', multiple: 'multiple' },
		});
		this.registerDomEvent(attachBtn, 'click', () => filePicker.click());
		this.registerDomEvent(filePicker, 'change', () => {
			if (filePicker.files && filePicker.files.length > 0) {
				void this.handleDroppedFiles(filePicker.files);
			}
			filePicker.value = '';
		});

		this.stopBtn = toolbar.createEl('button', { cls: 'vk-icon-btn vk-stop' });
		setIcon(this.stopBtn, 'square');
		this.stopBtn.setAttribute('aria-label', 'Stop generation');
		this.stopBtn.hide();
		this.registerDomEvent(this.stopBtn, 'click', () => this.abort?.abort());

		this.sendBtn = toolbar.createEl('button', { cls: 'vk-icon-btn vk-send' });
		setIcon(this.sendBtn, 'arrow-up');
		this.sendBtn.setAttribute('aria-label', 'Send');
		this.sendBtn.disabled = true;
		this.registerDomEvent(this.sendBtn, 'click', () => void this.send());
	}

	private autosizeComposer(): void {
		this.composerEl.style.height = 'auto';
		const min = 110;
		const max = 240;
		const next = Math.min(max, Math.max(min, this.composerEl.scrollHeight));
		this.composerEl.style.height = next + 'px';
	}

	private async handleDroppedFiles(files: FileList): Promise<void> {
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
				const block = await attachImageToVault(this.app, buf, f.name, f.type);
				this.pendingImages.push(block);
			} catch (e) {
				new Notice(`Could not attach ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.refreshAttachmentChips();
		this.updateSendState();
	}

	/**
	 * If `data` looks like a vault note path, pin it as context and return true.
	 * Returns false for anything that isn't a resolvable markdown file in the vault.
	 */
	private tryPinVaultPath(data: string): boolean {
		if (data.startsWith('[[')) return false;
		const looksLikeMd = data.endsWith('.md');
		const file = this.app.vault.getFileByPath(data);
		if (!looksLikeMd && !file) return false;
		const path = file ? file.path : data;
		if (!this.app.vault.getFileByPath(path)) return false;
		this.pinned.add(path);
		this.refreshContextChips();
		return true;
	}

	private async attachVaultImage(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(`Not found: ${path}`);
			return;
		}
		const mime = mimeFromExtension(path);
		if (!isSupportedImageMime(mime)) {
			new Notice(`${mime} isn't supported. Use JPEG, PNG, GIF, or WebP.`);
			return;
		}
		// Reference the vault file in place — no copy. Same shape attachImageToVault returns.
		this.pendingImages.push({ type: 'image', path, mime });
		this.refreshAttachmentChips();
		this.updateSendState();
	}

	private refreshAttachmentChips(): void {
		this.attachmentRowEl.empty();
		if (this.pendingImages.length === 0) {
			this.attachmentRowEl.hide();
			return;
		}
		this.attachmentRowEl.show();
		for (let i = 0; i < this.pendingImages.length; i++) {
			const block = this.pendingImages[i];
			const chip = this.attachmentRowEl.createDiv({ cls: 'vk-attachment-chip' });
			const file = this.app.vault.getFileByPath(block.path);
			if (file) {
				const img = chip.createEl('img', { cls: 'vk-attachment-thumb' });
				img.src = this.app.vault.getResourcePath(file);
			}
			chip.createSpan({ cls: 'vk-attachment-name', text: block.path.split('/').pop() ?? block.path });
			const removeBtn = chip.createEl('button', { cls: 'vk-icon-btn vk-attachment-remove', attr: { type: 'button' } });
			setIcon(removeBtn, 'x');
			removeBtn.setAttribute('aria-label', 'Remove attachment');
			const idx = i;
			this.registerDomEvent(removeBtn, 'click', () => {
				this.pendingImages.splice(idx, 1);
				this.refreshAttachmentChips();
				this.updateSendState();
			});
		}
	}

	openNoteMentionPicker(): void {
		new NotePickerModal(this.app, (file) => this.pinViaMention(file)).open();
		void this.maybeShowMentionTip();
	}

	private openSkillPicker(skills: Skill[]): void {
		new SkillPickerModal(this.app, skills, (skill) => {
			this.composerEl.value = `/${skill.name} `;
			const end = this.composerEl.value.length;
			this.composerEl.setSelectionRange(end, end);
			this.composerEl.focus();
			this.autosizeComposer();
			this.updateSendState();
		}).open();
	}

	/**
	 * Pin the picked note as context (model sees its content prepended to the
	 * next user turn). If the user typed `@<query>` to open the picker, strip
	 * the trigger from the textarea so the message reads naturally.
	 */
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
		this.pinned.add(file.path);
		this.refreshContextChips();
		this.composerEl.focus();
		this.autosizeComposer();
		this.updateSendState();
	}

	private async maybeShowMentionTip(): Promise<void> {
		if (this.plugin.settings.hasSeenMentionTip) return;
		this.plugin.settings.hasSeenMentionTip = true;
		await this.plugin.saveSettings();
		new Notice('@ now pins a note as context. Use [[ for an inline link.', 6000);
	}

	private insertAtCursor(text: string): void {
		const value = this.composerEl.value;
		const start = this.composerEl.selectionStart ?? value.length;
		const end = this.composerEl.selectionEnd ?? start;
		this.composerEl.value = value.slice(0, start) + text + value.slice(end);
		const newCursor = start + text.length;
		this.composerEl.setSelectionRange(newCursor, newCursor);
		this.composerEl.focus();
		this.autosizeComposer();
		this.updateSendState();
	}

	private updateSendState(): void {
		const empty = this.composerEl.value.trim().length === 0 && this.pendingImages.length === 0;
		const streaming = this.abort !== null;
		this.sendBtn.disabled = empty || streaming;
	}

	private refreshModelChip(): void {
		const friendly = friendlyModelName(this.modelRef.slug);
		const endpoint = findEndpoint(this.plugin.settings, this.modelRef.endpointId);
		this.modelChip.empty();
		// In-chip label is ALWAYS just the friendly name — endpoint context goes in
		// the tooltip. Keeps "DeepSeek V4 Pro" intact in a narrow sidebar instead
		// of truncating it to "Deep…".
		this.modelChip.createSpan({ cls: 'vk-model-chip-name', text: friendly });
		this.modelChip.createSpan({ cls: 'vk-model-chip-chevron', text: '▾' });
		this.modelChip.title = `${this.modelRef.slug} · ${endpoint?.name ?? this.modelRef.endpointId}`;
		this.modelChip.setAttribute('aria-label', `Model: ${friendly}. Click to change.`);
	}

	openModelPicker(): void {
		new ModelPickerModal(
			this.app,
			this.plugin.settings.endpoints,
			this.modelRef,
			this.plugin.settings.modelRecents,
			(picked) => void this.setModel(picked),
		).open();
	}

	private async setModel(newRef: ModelRef): Promise<void> {
		if (newRef.endpointId === this.modelRef.endpointId && newRef.slug === this.modelRef.slug) return;
		this.modelRef = newRef;
		this.refreshModelChip();
		// Context window and pricing change with the model — refresh the chip.
		void this.refreshTokenChip();

		this.plugin.settings.modelRecents = bumpRecent(this.plugin.settings.modelRecents, newRef);
		await this.plugin.saveSettings();

		if (this.session) {
			const e = this.plugin.storage.makeModelChangeEntry(
				newRef.endpointId,
				newRef.slug,
				this.session.leafId,
			);
			await this.plugin.storage.appendEntry(this.session, e);
		}
	}

	/**
	 * Two-layer token display: ambient percentage of the model's context window
	 * (faint until 70%, muted at 70–90%, warning above 90%). Tap to expand a
	 * popover with the breakdown and pre-send cost projection.
	 */
	private async refreshTokenChip(): Promise<void> {
		if (!this.tokenChip) return;
		if (!this.cachedBreakdown) {
			this.cachedBreakdown = await this.computeContextProjection();
		} else {
			this.cachedBreakdown.composer = estimateTokens(this.composerEl?.value ?? '');
		}
		const total = sumBreakdown(this.cachedBreakdown);
		const { endpoint, slug } = resolveModelRef(this.plugin.settings, this.modelRef);
		const meta = endpoint.discoveredModels?.find((m) => m.id === slug);
		const contextLength = meta?.contextLength;

		this.tokenChip.empty();
		this.tokenChip.removeClass('vk-token-warn');
		this.tokenChip.removeClass('vk-token-muted');

		const display = formatTokenChip(total, contextLength);
		if (display.severity === 'warn') this.tokenChip.addClass('vk-token-warn');
		else if (display.severity === 'muted') this.tokenChip.addClass('vk-token-muted');
		if (display.pct) {
			this.tokenChip.createSpan({ cls: 'vk-token-pct', text: display.pct });
		}
		if (display.abs) {
			this.tokenChip.createSpan({
				cls: 'vk-token-abs',
				text: `${display.pct ? ' · ' : ''}${display.abs}`,
			});
		}

		if (this.tokenPopover) this.renderTokenPopoverInto(this.tokenPopover);
	}

	private invalidateBreakdownCache(): void {
		this.cachedBreakdown = null;
	}

	private async computeContextProjection(): Promise<TokenBreakdown> {
		const base = estimateTokens(this.plugin.settings.systemPrompt);
		const vault = estimateTokens(this.plugin.agents.text());
		const skillsManifest = estimateTokens(this.plugin.skills.manifestText());

		let pinned = 0;
		for (const p of this.pinned.list()) {
			const s = await this.pinned.statusOf(p);
			if (s) pinned += s.tokens;
		}

		let skillsLoaded = 0;
		for (const skillName of this.loadedSkills) {
			const skill = this.plugin.skills.getByName(skillName);
			if (skill) skillsLoaded += estimateTokens(skill.body);
		}

		let history = 0;
		if (this.session) {
			const chain = this.plugin.storage.contextChain(this.session);
			for (const e of chain) {
				if (e.type !== 'message') continue;
				const m = e.message;
				if (typeof m.content === 'string') {
					history += estimateTokens(m.content);
				} else {
					for (const b of m.content) {
						if (b.type === 'text') history += estimateTokens(b.text);
						else if (b.type === 'toolCall')
							history += estimateTokens(JSON.stringify(b.arguments)) + 6;
						else if (b.type === 'toolResult') history += estimateTokens(b.content);
					}
				}
			}
		}

		const composer = estimateTokens(this.composerEl?.value ?? '');
		return { base, vault, skillsManifest, pinned, skillsLoaded, history, composer };
	}

	private toggleTokenPopover(): void {
		if (this.tokenPopover) {
			this.closeTokenPopover();
			return;
		}
		const parent = this.tokenChip.parentElement;
		if (!parent) return;
		this.tokenPopover = parent.createDiv({ cls: 'vk-token-popover' });
		this.renderTokenPopoverInto(this.tokenPopover);
		// Click-outside dismiss — registered on document so taps anywhere close it.
		this.tokenPopoverDismisser = (ev: MouseEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (this.tokenPopover?.contains(target) || this.tokenChip.contains(target)) return;
			this.closeTokenPopover();
		};
		// Wait a tick so the click that opened the popover doesn't immediately close it.
		window.setTimeout(() => {
			if (this.tokenPopoverDismisser) {
				document.addEventListener('click', this.tokenPopoverDismisser);
			}
		}, 0);
	}

	private closeTokenPopover(): void {
		if (this.tokenPopoverDismisser) {
			document.removeEventListener('click', this.tokenPopoverDismisser);
			this.tokenPopoverDismisser = null;
		}
		this.tokenPopover?.remove();
		this.tokenPopover = null;
	}

	private renderTokenPopoverInto(popover: HTMLElement): void {
		popover.empty();
		const b = this.cachedBreakdown;
		if (!b) {
			popover.setText('Computing…');
			return;
		}
		const total = sumBreakdown(b);
		const { endpoint, slug } = resolveModelRef(this.plugin.settings, this.modelRef);
		const meta = endpoint.discoveredModels?.find((m) => m.id === slug);

		const header = popover.createDiv({ cls: 'vk-token-popover-header' });
		if (meta?.contextLength) {
			const pct = Math.round((total / meta.contextLength) * 100);
			header.setText(
				`Context window: ${formatTokens(total)} / ${formatTokens(meta.contextLength)} (${pct}%)`,
			);
		} else {
			header.setText(`Projected next turn: ${formatTokens(total)}`);
		}

		const rows = popover.createDiv({ cls: 'vk-token-popover-rows' });
		const addRow = (label: string, tokens: number): void => {
			if (tokens === 0) return;
			const row = rows.createDiv({ cls: 'vk-token-popover-row' });
			row.createSpan({ cls: 'vk-token-popover-label', text: label });
			row.createSpan({ cls: 'vk-token-popover-val', text: formatTokens(tokens) });
		};
		addRow('System prompt', b.base);
		addRow('Vault context (AGENTS)', b.vault);
		addRow('Skill catalog', b.skillsManifest);
		addRow('Pinned notes', b.pinned);
		addRow('Loaded skills', b.skillsLoaded);
		addRow('Chat history', b.history);
		addRow('Composer text', b.composer);

		const footer = popover.createDiv({ cls: 'vk-token-popover-footer' });
		const projection = footer.createDiv({ cls: 'vk-token-popover-projection' });
		const COMPLETION_ESTIMATE = 500;
		const costStr = formatCostUsd(total, COMPLETION_ESTIMATE, meta);
		const tail = costStr ? ` · ${costStr}` : '';
		projection.setText(`Next turn ≈ ${formatTokens(total)}${tail}`);

		const cumulative = this.cumulativeTokens;
		if (cumulative.prompt + cumulative.completion > 0) {
			const cumStr = formatCostUsd(cumulative.prompt, cumulative.completion, meta);
			const cumTail = cumStr ? ` · ${cumStr}` : '';
			const cacheStr =
				cumulative.cached > 0 && cumulative.prompt > 0
					? ` · ${Math.round((cumulative.cached / cumulative.prompt) * 100)}% cached`
					: '';
			footer.createDiv({
				cls: 'vk-token-popover-cumulative',
				text: `Session so far: ${formatTokens(cumulative.prompt + cumulative.completion)}${cumTail}${cacheStr}`,
			});
		}
	}

	private updateTabTitle(): void {
		this.refreshTopbarTitle();
		const refresh = (this.app.workspace as unknown as { trigger?: (e: string) => void }).trigger;
		refresh?.call(this.app.workspace, 'layout-change');
	}

	refreshDangerChip(): void {
		if (!this.dangerChip) return;
		const on = this.plugin.settings.autoApproveWrites;
		this.dangerChip.toggleClass('is-visible', on);
	}

	private openPluginSettings(): void {
		const setting = (this.app as unknown as {
			setting?: { open?: () => void; openTabById?: (id: string) => void };
		}).setting;
		if (!setting?.open) return;
		setting.open();
		setting.openTabById?.('smart-aide');
	}

	private refreshTopbarTitle(): void {
		if (!this.titleBtn) return;
		const title = this.session?.title || 'Smart Aide';
		this.titleBtn.empty();
		this.titleBtn.createSpan({ cls: 'vk-topbar-title-name', text: title });
		this.titleBtn.createSpan({ cls: 'vk-topbar-title-chevron', text: '▾' });
	}

	private openRenameModal(): void {
		if (!this.session) return;
		const current = this.session.title;
		new RenameChatModal(this.app, current, async (newTitle) => {
			if (!this.session) return;
			const entry = this.plugin.storage.makeTitleEntry(newTitle, this.session.leafId);
			await this.plugin.storage.appendEntry(this.session, entry);
			this.session.title = newTitle;
			this.updateTabTitle();
		}).open();
	}

	private rerenderStream(): void {
		for (const child of this.streamRenderChildren) this.removeChild(child);
		this.streamRenderChildren = [];
		this.streamEl.empty();
		if (!this.session) return;
		const chain = this.plugin.storage.contextChain(this.session);

		this.turnUsageByEntry.clear();
		for (const entry of chain) {
			if (entry.type === 'custom' && entry.customType === 'turn-usage' && entry.data) {
				const d = entry.data as Partial<TurnUsage & { targetEntryId: string }>;
				if (d.targetEntryId && typeof d.promptTokens === 'number' && typeof d.completionTokens === 'number') {
					this.turnUsageByEntry.set(d.targetEntryId, {
						promptTokens: d.promptTokens,
						completionTokens: d.completionTokens,
						cachedTokens: d.cachedTokens,
					});
				}
			}
		}

		let bursts = groupChainIntoBursts(chain);

		const skillSet = new Set<string>();
		for (const b of bursts) for (const s of b.activity.loadedSkills) skillSet.add(s);
		this.loadedSkills = [...skillSet];
		this.invalidateBreakdownCache();
		void this.refreshTokenChip();
		this.refreshContextChips();

		const hasContent = bursts.some(
			(b) => b.user || b.activity.toolCalls.length > 0 || b.activity.loadedSkills.length > 0 || b.final,
		);
		if (!hasContent) {
			this.renderEmptyState();
			return;
		}

		// When editing a previous user message, drop that burst and everything after —
		// they'll be replaced when Send forks.
		if (this.editingFromId) {
			const cutIdx = bursts.findIndex((b) => b.user?.id === this.editingFromId);
			if (cutIdx >= 0) bursts = bursts.slice(0, cutIdx);
		}

		for (const burst of bursts) this.renderBurst(burst);
		this.scrollToBottom();
	}

	/**
	 * One user message produces one burst: their bubble, optionally an activity
	 * card (research chip + citation cards) for everything the model did, and the
	 * final text answer (if any). Collapses multi-turn tool runs into a single
	 * legible unit instead of one row per tool turn.
	 */
	private renderBurst(burst: Burst): void {
		const burstEl = this.streamEl.createDiv({ cls: 'vk-burst' });

		if (burst.user) {
			const userWrap = this.renderMessageEntry(burst.user);
			burstEl.appendChild(userWrap);
		}

		const hasActivity =
			burst.activity.toolCalls.length > 0 ||
			burst.activity.loadedSkills.length > 0 ||
			burst.activity.invokedSkill !== null;
		if (hasActivity) {
			const wrap = burstEl.createDiv({ cls: 'vk-msg vk-role-assistant vk-burst-activity' });
			const body = wrap.createDiv({ cls: 'vk-body' });
			renderResearchChip(
				body,
				burst.activity.toolCalls,
				burst.activity.toolResults,
				burst.activity.loadedSkills,
				burst.activity.invokedSkill,
			);
			for (const call of burst.activity.toolCalls) {
				if (call.name !== 'read_note') continue;
				const result = burst.activity.toolResults.find((r) => r.toolCallId === call.id);
				if (!result || result.isError) continue;
				renderCitationCard(body, result);
			}

			let p = 0;
			let c = 0;
			let cached = 0;
			let any = false;
			for (const id of burst.activity.entryIds) {
				const u = this.turnUsageByEntry.get(id);
				if (!u) continue;
				p += u.promptTokens;
				c += u.completionTokens;
				cached += u.cachedTokens ?? 0;
				any = true;
			}
			if (any) {
				wrap.title = formatUsageTooltip({
					promptTokens: p,
					completionTokens: c,
					cachedTokens: cached,
				});
			}
		}

		if (burst.final) {
			const finalWrap = this.renderMessageEntry(burst.final);
			burstEl.appendChild(finalWrap);
		}
	}

	private renderEmptyState(): void {
		const empty = this.streamEl.createDiv({ cls: 'vk-empty' });
		const icon = empty.createDiv({ cls: 'vk-empty-icon' });
		setIcon(icon, 'message-square');
		empty.createDiv({ cls: 'vk-empty-text', text: 'Ask anything about your vault.' });
		empty.createDiv({
			cls: 'vk-empty-sub',
			text: 'I can search and read notes, follow backlinks, and propose edits (with your approval).',
		});

		// Meta lines that show "what does the model already see" before turn 1.
		const meta = empty.createDiv({ cls: 'vk-empty-meta' });
		const pinList = this.pinned.list();
		if (pinList.length > 0) {
			const names = pinList
				.map((p) => p.replace(/\.md$/i, '').split('/').pop() ?? p)
				.join(', ');
			meta.createDiv({ cls: 'vk-empty-meta-row', text: `📌 Pinned: ${names}` });
		}
		const skillCount = this.plugin.skills.visibleOnThisPlatform().length;
		const agentsLoaded = this.plugin.agents.text().length > 0;
		const skillParts: string[] = [];
		if (skillCount > 0) {
			skillParts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'} available`);
		}
		if (agentsLoaded) {
			skillParts.push('vault context loaded');
		}
		if (skillParts.length > 0) {
			meta.createDiv({ cls: 'vk-empty-meta-row', text: `🧠 ${skillParts.join(' · ')}` });
		}
	}

	private renderMessageEntry(entry: MessageEntry): HTMLElement {
		const m = entry.message;
		const wrap = this.streamEl.createDiv({ cls: `vk-msg vk-role-${m.role}` });

		const body = wrap.createDiv({ cls: 'vk-body' });
		const renderAsMarkdown = m.role === 'assistant' || m.role === 'user';
		if (typeof m.content === 'string') {
			this.renderText(body, m.content, renderAsMarkdown);
		} else {
			for (const block of m.content) {
				if (block.type === 'text') this.renderText(body, block.text, renderAsMarkdown);
				else if (block.type === 'toolCall') renderToolCallBlock(body, block);
				else if (block.type === 'toolResult') renderToolResultBlock(body, block);
				else if (block.type === 'image') renderImageBlock(this.app, body, block);
			}
		}

		// Per-turn usage moves to a hover tooltip on the wrap — cumulative is in the toolbar.
		if (m.role === 'assistant') {
			const usage = this.turnUsageByEntry.get(entry.id);
			if (usage) wrap.title = formatUsageTooltip(usage);
		}

		if (m.role === 'user') {
			const actions = wrap.createDiv({ cls: 'vk-msg-actions' });
			const editBtn = actions.createEl('button', { cls: 'vk-icon-btn vk-edit' });
			setIcon(editBtn, 'pencil');
			editBtn.setAttribute('aria-label', 'Edit & branch');
			this.registerDomEvent(editBtn, 'click', () => this.startEditBranch(entry));
		}

		return wrap;
	}

	private renderText(parent: HTMLElement, text: string, asMarkdown: boolean): void {
		const div = parent.createDiv({ cls: 'vk-text' });
		if (!asMarkdown) {
			div.setText(text);
			return;
		}
		const child = new MarkdownRenderChild(div);
		this.addChild(child);
		this.streamRenderChildren.push(child);
		void MarkdownRenderer.render(this.app, text, div, '', child).then(() => {
			addCopyButtons(div);
		});
	}

	private scrollToBottom(): void {
		this.streamEl.scrollTop = this.streamEl.scrollHeight;
	}

	/**
	 * Open a wikilink target in the main workspace area (rootSplit), not in our sidebar.
	 * Keeps focus in the chat so the user can keep typing.
	 */
	private async openInternalLink(href: string, inNewTab: boolean): Promise<void> {
		const { path, subpath } = parseLinktext(href);
		const file = this.app.metadataCache.getFirstLinkpathDest(path, '');
		if (!file) {
			new Notice(`Link not found: ${href}`);
			return;
		}

		const mainRoot = this.app.workspace.rootSplit;
		let leaf: WorkspaceLeaf;
		if (inNewTab) {
			// Force the new tab to land in the main area: switch active leaf to a
			// main-area leaf first (without stealing focus), then create the tab.
			const anchor = this.app.workspace.getMostRecentLeaf(mainRoot);
			if (anchor) this.app.workspace.setActiveLeaf(anchor, { focus: false });
			leaf = this.app.workspace.getLeaf('tab');
		} else {
			// Reuse the most recent main-area leaf, or create a new tab there if none.
			const existing = this.app.workspace.getMostRecentLeaf(mainRoot);
			if (existing) {
				leaf = existing;
			} else {
				leaf = this.app.workspace.getLeaf('tab');
			}
		}

		const openState = subpath ? { eState: { subpath } } : undefined;
		await leaf.openFile(file, openState);
		this.app.workspace.revealLeaf(leaf);
	}

	private refreshContextChips(): void {
		if (!this.contextRowEl) return;
		this.contextRowEl.empty();
		// Pins/skills/AGENTS all feed the token projection — keep the chip in sync
		// from the same callsite that draws the strip.
		this.invalidateBreakdownCache();
		void this.refreshTokenChip();

		const pinList = this.pinned.list();

		for (const path of pinList) {
			const chip = this.contextRowEl.createEl('button', {
				cls: 'vk-context-chip',
				attr: { type: 'button' },
			});
			const basename = path.replace(/\.md$/i, '').split('/').pop() ?? path;
			chip.createSpan({ cls: 'vk-context-chip-name', text: basename });
			chip.title = `Pinned: ${path}`;
			void this.pinned.statusOf(path).then((status) => {
				if (!status) return;
				if (status.truncated) {
					chip.addClass('vk-context-chip-truncated');
					chip.title = `${basename} · ${formatTokens(status.tokens)} · truncated. Capped at ~${Math.round(status.sentBytes / 1000)}KB; full file is ${Math.round(status.totalBytes / 1000)}KB. Use read_note for the rest.`;
				} else if (status.tokens > 0) {
					chip.title = `${basename} · ${formatTokens(status.tokens)}`;
				}
			});
			const x = chip.createSpan({ cls: 'vk-context-chip-x', text: '×' });
			x.setAttribute('aria-label', `Unpin ${basename}`);
			this.registerDomEvent(x, 'click', (ev) => {
				ev.stopPropagation();
				this.pinned.remove(path);
				this.refreshContextChips();
			});
			this.registerDomEvent(chip, 'click', (ev) => {
				if ((ev.target as HTMLElement).classList.contains('vk-context-chip-x')) return;
				void this.openInternalLink(path.replace(/\.md$/i, ''), false);
			});
		}

		// Skill chips — surface which skills the model has loaded so the user
		// can audit context (and click through to the skill body).
		for (const skillName of this.loadedSkills) {
			const skill = this.plugin.skills.getByName(skillName);
			const chip = this.contextRowEl.createEl('button', {
				cls: 'vk-context-chip vk-context-skill',
				attr: { type: 'button' },
			});
			chip.createSpan({ cls: 'vk-context-chip-name', text: skillName });
			if (skill) {
				chip.title = skill.description;
				this.registerDomEvent(chip, 'click', () =>
					void this.openInternalLink(skill.path.replace(/\.md$/i, ''), false),
				);
			} else {
				chip.title = `Skill "${skillName}" was loaded but is no longer on disk`;
			}
		}

		if (pinList.length >= 3) {
			const clearBtn = this.contextRowEl.createEl('button', {
				cls: 'vk-context-clear',
				attr: { type: 'button' },
				text: 'unpin all',
			});
			this.registerDomEvent(clearBtn, 'click', () => {
				this.pinned.clear();
				this.refreshContextChips();
			});
		}

		const addBtn = this.contextRowEl.createEl('button', {
			cls: 'vk-context-add',
			attr: { type: 'button' },
			text: '+ note',
		});
		addBtn.title = 'Pin a note as context';
		this.registerDomEvent(addBtn, 'click', () => this.openContextPicker());
	}

	private openContextPicker(): void {
		new NotePickerModal(
			this.app,
			(file) => {
				if (this.pinned.has(file.path)) {
					new Notice(`"${file.path}" is already pinned.`);
					return;
				}
				this.pinned.add(file.path);
				this.refreshContextChips();
			},
			'Pin a note as context…',
		).open();
	}

	private autoPinActive(): void {
		const active = this.app.workspace.getActiveFile();
		if (active instanceof TFile && active.extension === 'md') {
			this.pinned.add(active.path);
			this.refreshContextChips();
		}
	}

	private async startEditBranch(parentEntry: MessageEntry): Promise<void> {
		if (!this.session) return;
		this.composerEl.value = messageText(parentEntry.message);
		this.composerEl.dataset.branchParent = parentEntry.parentId ?? '';
		this.composerEl.dataset.branchFrom = parentEntry.id;
		this.autosizeComposer();
		this.updateSendState();
		this.composerEl.focus();
		this.showEditBanner();

		// Hide the message being edited and everything after it so the chat reflects
		// the post-fork state. Restored by cancelEdit or by send's rerender.
		this.editingFromId = parentEntry.id;
		this.rerenderStream();
	}

	private showEditBanner(): void {
		this.removeEditBanner();
		const wrap = this.composerEl.parentElement;
		if (!wrap) return;
		const banner = wrap.createDiv({ cls: 'vk-edit-banner' });
		banner.createSpan({ cls: 'vk-edit-banner-text', text: 'Editing — Send to fork from this message' });
		const cancel = banner.createEl('button', { cls: 'vk-edit-banner-cancel', text: 'Cancel' });
		this.registerDomEvent(cancel, 'click', () => this.cancelEdit());
		// Place the banner above the textarea inside the composer wrap.
		wrap.insertBefore(banner, this.composerEl);
	}

	private removeEditBanner(): void {
		const wrap = this.composerEl?.parentElement;
		if (!wrap) return;
		const existing = wrap.querySelector('.vk-edit-banner');
		if (existing) existing.remove();
	}

	private cancelEdit(): void {
		delete this.composerEl.dataset.branchFrom;
		delete this.composerEl.dataset.branchParent;
		this.composerEl.value = '';
		this.autosizeComposer();
		this.updateSendState();
		this.removeEditBanner();
		if (this.editingFromId) {
			this.editingFromId = null;
			this.rerenderStream();
		}
	}

	private async send(): Promise<void> {
		if (!this.session) return;
		const { endpoint } = resolveModelRef(this.plugin.settings, this.modelRef);
		if (!endpoint.apiKey) {
			new Notice(`Set the API key for "${endpoint.name}" in smart-aide settings.`);
			return;
		}
		const rawText = this.composerEl.value.trim();
		if (!rawText && this.pendingImages.length === 0) return;

		// Slash invocation: `/<name> <body>` summons a user-invocable skill for this
		// turn. The skill body is prepended as a custom_message entry, and any
		// allowed-tools allowlist scopes the tool registry for the whole assistant
		// loop. Unknown slash names fall through and send verbatim.
		const userInvocableSkills = this.plugin.skills.userInvocableSkills();
		const invocation = parseSlashInvocation(
			rawText,
			userInvocableSkills.map((s) => s.name),
		);
		let invokedSkill: Skill | null = null;
		let text = rawText;
		if (invocation) {
			invokedSkill = this.plugin.skills.getByName(invocation.name);
			text = invocation.rest;
			if (!text && this.pendingImages.length === 0) return;
		}

		// Resolve parent: branch if editing, else current leaf
		let parentId: string | null;
		if (this.composerEl.dataset.branchFrom) {
			parentId = this.composerEl.dataset.branchParent || null;
			delete this.composerEl.dataset.branchFrom;
			delete this.composerEl.dataset.branchParent;
			this.removeEditBanner();
			this.editingFromId = null;
		} else {
			parentId = this.session.leafId;
		}

		// Snapshot + clear pending images before composing so a re-entrant click can't double-send.
		const images = this.pendingImages;
		this.pendingImages = [];
		this.composerEl.value = '';
		this.refreshAttachmentChips();
		this.autosizeComposer();
		this.updateSendState();

		// Per-turn grants reset at the start of each user turn
		this.approveAllInTurn = false;

		// Persist the invocation marker BEFORE the user message so the model sees
		// the skill body in the same turn the user typed `/`.
		if (invokedSkill) {
			const invEntry = this.plugin.storage.makeCustomMessageEntry(
				'skill-invocation',
				invokedSkill.body,
				invokedSkill.name,
				parentId,
			);
			await this.plugin.storage.appendEntry(this.session, invEntry);
			parentId = invEntry.id;
		}

		let content: AgentMessage['content'];
		if (images.length === 0) {
			content = text;
		} else {
			const blocks: ContentBlock[] = [];
			if (text) blocks.push({ type: 'text', text });
			for (const img of images) blocks.push(img);
			content = blocks;
		}
		const userMessage: AgentMessage = { role: 'user', content };
		const userEntry = this.plugin.storage.makeMessageEntry(userMessage, parentId);
		await this.plugin.storage.appendEntry(this.session, userEntry);
		this.rerenderStream();

		await this.runAssistantLoop(invokedSkill?.allowedTools ?? null);
		if (this.session) {
			void maybeAutoTitle({
				session: this.session,
				settings: this.plugin.settings,
				storage: this.plugin.storage,
				onTitled: () => this.updateTabTitle(),
			});
		}
	}

	private composeSystemPrompt(): string {
		const base = this.plugin.settings.systemPrompt;
		const agentsBody = this.plugin.agents.text();
		const manifest = this.plugin.skills.manifestText();
		const sections = [base];
		if (agentsBody) {
			sections.push(`Vault context (user-maintained):\n\n${agentsBody}`);
		}
		if (manifest) sections.push(manifest);
		return sections.join('\n\n');
	}

	private async runAssistantLoop(allowedTools: string[] | null = null): Promise<void> {
		if (!this.session) return;

		this.abort = new AbortController();
		this.stopBtn.show();
		this.sendBtn.hide();
		this.updateSendState();

		let hitTurnCap = false;
		try {
			for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
				// Re-read pinned context each iteration so file edits during the turn show up.
				const pinnedPreamble = (await this.pinned.buildPreamble()) || undefined;

				// Live assistant message bubble that fills as text streams
				const liveWrap = this.streamEl.createDiv({ cls: 'vk-msg vk-role-assistant vk-streaming' });
				const liveBody = liveWrap.createDiv({ cls: 'vk-body' });
				const liveText = liveBody.createDiv({ cls: 'vk-text' });
				const thinking = liveBody.createDiv({ cls: 'vk-thinking' });
				thinking.createSpan({ cls: 'vk-thinking-dot' });
				thinking.createSpan({ cls: 'vk-thinking-dot' });
				thinking.createSpan({ cls: 'vk-thinking-dot' });
				const toolCardEls = new Map<number, HTMLElement>();
				const clearThinking = () => {
					if (thinking.parentElement) thinking.remove();
				};

				const { endpoint, slug } = resolveModelRef(this.plugin.settings, this.modelRef);
				const provider = providerFor(endpoint);
				let assembled;
				try {
					assembled = await provider.runTurn(
						{
							endpoint,
							model: slug,
							chain: this.plugin.storage.contextChain(this.session),
							systemPrompt: this.composeSystemPrompt(),
							tools: filterTools(
								[...toolsToDescriptors(TOOLS), LOAD_SKILL_TOOL_DEF],
								allowedTools,
							),
							pinnedPreamble,
							enablePromptCaching: this.plugin.settings.anthropicPromptCaching,
							signal: this.abort.signal,
						},
						(path) => this.plugin.storage.resolveImageBytes(path),
						{
							onText: (delta) => {
								clearThinking();
								liveText.setText(liveText.getText() + delta);
								this.scrollToBottom();
							},
							onToolCallProgress: (index, partial) => {
								clearThinking();
								let el = toolCardEls.get(index);
								if (!el) {
									el = liveBody.createDiv({ cls: 'vk-tool-call' });
									el.createDiv({ cls: 'vk-tool-name', text: `🔧 ${partial.name || '…'}` });
									el.createEl('pre', { cls: 'vk-tool-args' });
									toolCardEls.set(index, el);
								}
								const nameEl = el.querySelector('.vk-tool-name');
								if (nameEl && partial.name) nameEl.setText(`🔧 ${partial.name}`);
								const argsEl = el.querySelector('.vk-tool-args');
								if (argsEl) argsEl.setText(partial.argsAccum || '');
								this.scrollToBottom();
							},
							onUsage: (u) => {
								this.cumulativeTokens.prompt += u.promptTokens;
								this.cumulativeTokens.completion += u.completionTokens;
								this.cumulativeTokens.cached += (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
								void this.refreshTokenChip();
							},
						},
					);
				} catch (e) {
					liveWrap.remove();
					if ((e as Error).name === 'AbortError') {
						new Notice('Stopped.');
					} else {
						new Notice(`Chat error: ${(e as Error).message}`);
					}
					break;
				}

				// Remove the live element; we'll re-render from persisted state for consistency.
				liveWrap.remove();

				// Persist the assistant message
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
				const assistantEntry = this.plugin.storage.makeMessageEntry(
					{ role: 'assistant', content: blocks.length ? blocks : assembled.text || '' },
					this.session.leafId,
				);
				await this.plugin.storage.appendEntry(this.session, assistantEntry);

				// Persist per-turn usage so it can be rendered alongside the assistant message
				if (assembled.usage) {
					const cached =
						(assembled.usage.cachedReadTokens ?? 0) + (assembled.usage.cachedWriteTokens ?? 0);
					const usageEntry = this.plugin.storage.makeCustomEntry(
						'turn-usage',
						{
							targetEntryId: assistantEntry.id,
							promptTokens: assembled.usage.promptTokens,
							completionTokens: assembled.usage.completionTokens,
							cachedTokens: cached || undefined,
						},
						this.session.leafId,
					);
					await this.plugin.storage.appendEntry(this.session, usageEntry);
				}

				// Render the persisted assistant message now — before entering the dispatch
				// loop — so the user sees the model's preamble + tool call list above any
				// approval card we're about to render. Without this, a write_note that
				// requires approval surfaces the card against stale DOM, and on mobile the
				// card lands below the visible viewport with no anchor for the user.
				this.rerenderStream();

				if (assembled.toolCalls.length === 0) {
					break;
				}

				// Execute tool calls. Writes go through ONE batched approval card per
				// turn (with per-item checkboxes). Deletes still confirm individually.
				const { writeDecisions, deleteDecisions } = await this.collectApprovals(assembled.toolCalls);
				const resultBlocks: ContentBlock[] = [];
				for (const tc of assembled.toolCalls) {
					const args = safeParse(tc.arguments);
					const decision = writeDecisions.get(tc.id) ?? deleteDecisions.get(tc.id);
					const out = await this.runOneToolCall(tc.name, args, decision);
					resultBlocks.push({ type: 'toolResult', toolCallId: tc.id, content: out });
				}
				const toolEntry = this.plugin.storage.makeMessageEntry(
					{ role: 'tool', content: resultBlocks },
					this.session.leafId,
				);
				await this.plugin.storage.appendEntry(this.session, toolEntry);
				this.rerenderStream();

				if (this.abort.signal.aborted) break;
				if (turn === MAX_TOOL_TURNS - 1) {
					hitTurnCap = true;
					break;
				}
				// Loop continues — model sees tool results in next turn.
			}

			if (hitTurnCap && this.session) {
				const notice =
					`_Stopped after ${MAX_TOOL_TURNS} tool turns to avoid runaway tool use. ` +
					`Ask again if you want me to continue from here._`;
				const capEntry = this.plugin.storage.makeMessageEntry(
					{ role: 'assistant', content: notice },
					this.session.leafId,
				);
				await this.plugin.storage.appendEntry(this.session, capEntry);
				this.rerenderStream();
			}
		} finally {
			this.stopBtn.hide();
			this.sendBtn.show();
			this.abort = null;
			this.updateSendState();
			this.updateTabTitle();
		}
	}

	/**
	 * Build approval previews for every write/delete in the model's tool-call
	 * batch, then resolve decisions. Writes go through ONE batched card (or are
	 * pre-approved via auto-approve / approve-all-turn). Deletes confirm
	 * individually — one wrong delete is worse than five wrong appends.
	 */
	private async collectApprovals(calls: ToolCall[]): Promise<{
		writeDecisions: Map<string, ApprovalDecision>;
		deleteDecisions: Map<string, ApprovalDecision>;
	}> {
		const writeDecisions = new Map<string, ApprovalDecision>();
		const deleteDecisions = new Map<string, ApprovalDecision>();
		const ctx = { app: this.app, metaDir: this.plugin.settings.metaDir };

		const writeItems: BatchApprovalItem[] = [];
		const deleteItems: BatchApprovalItem[] = [];
		for (const tc of calls) {
			if (tc.name === LOAD_SKILL_NAME) continue;
			const tool = TOOLS.find((t) => t.name === tc.name);
			if (!tool) continue;
			if (tool.risk !== 'write' && tool.risk !== 'delete') continue;
			const args = safeParse(tc.arguments);
			let preview;
			try {
				preview = tool.preview
					? await tool.preview(args, ctx)
					: { summary: `${tc.name}(${Object.keys(args).join(', ')})` };
			} catch (e) {
				preview = { summary: `${tc.name} — preview failed: ${(e as Error).message}` };
			}
			const item: BatchApprovalItem = { callId: tc.id, tool, args, preview };
			if (tool.risk === 'write') writeItems.push(item);
			else deleteItems.push(item);
		}

		if (writeItems.length > 0) {
			if (this.abort?.signal.aborted) {
				for (const item of writeItems) {
					writeDecisions.set(item.callId, { approved: false, reason: 'Stopped by user.' });
				}
			} else if (this.plugin.settings.autoApproveWrites) {
				for (const item of writeItems) {
					writeDecisions.set(item.callId, { approved: true, scope: 'inherited-turn' });
				}
			} else if (this.approveAllInTurn) {
				for (const item of writeItems) {
					writeDecisions.set(item.callId, { approved: true, scope: 'inherited-turn' });
				}
			} else {
				const result = await requestBatchedWriteApprovals(
					this,
					this.streamEl,
					() => this.scrollToBottom(),
					writeItems,
					this.abort?.signal,
				);
				for (const [id, d] of result) {
					writeDecisions.set(id, d);
					if (d.approved && d.scope === 'turn') this.approveAllInTurn = true;
				}
			}
		}

		for (const item of deleteItems) {
			if (this.abort?.signal.aborted) {
				deleteDecisions.set(item.callId, { approved: false, reason: 'Stopped by user.' });
				continue;
			}
			const decision = await requestApproval(
				this,
				this.streamEl,
				() => this.scrollToBottom(),
				item.tool,
				item.preview,
				this.abort?.signal,
			);
			deleteDecisions.set(item.callId, decision);
		}

		return { writeDecisions, deleteDecisions };
	}

	/**
	 * Run one tool call, given a pre-computed approval decision for write/delete
	 * tools. Reads execute immediately; load_skill goes through skill-load
	 * persistence. Approval audit is persisted regardless of outcome.
	 */
	private async runOneToolCall(
		name: string,
		args: Record<string, unknown>,
		preDecision: ApprovalDecision | undefined,
	): Promise<string> {
		if (!this.session) return JSON.stringify({ error: 'no session' });

		if (name === LOAD_SKILL_NAME) return this.handleSkillLoad(args);

		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` });

		if (tool.risk === 'write' || tool.risk === 'delete') {
			const decision = preDecision ?? { approved: false, reason: 'No approval recorded.' };
			await this.persistApprovalAudit(name, args, decision);
			if (!decision.approved) {
				return JSON.stringify({
					status: 'denied',
					reason: decision.reason ?? 'User rejected the operation.',
				});
			}
		}

		try {
			return await tool.execute(args, { app: this.app, metaDir: this.plugin.settings.metaDir });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return JSON.stringify({ error: `tool ${name} failed: ${msg}` });
		}
	}

	private async handleSkillLoad(args: Record<string, unknown>): Promise<string> {
		if (!this.session) return JSON.stringify({ error: 'no session' });
		const skillName = String(args.name ?? '').trim();
		if (!skillName) return JSON.stringify({ error: 'name is required' });
		const skill = this.plugin.skills.loadable(skillName);
		if (!skill) {
			return JSON.stringify({
				error: `no skill named '${skillName}'`,
				available: this.plugin.skills.visibleOnThisPlatform().map((s) => s.name),
			});
		}
		const entry = this.plugin.storage.makeCustomMessageEntry(
			'skill',
			skill.body,
			`skill: ${skill.name}`,
			this.session.leafId,
		);
		await this.plugin.storage.appendEntry(this.session, entry);
		return JSON.stringify({ status: 'loaded', skill: skill.name });
	}

	private async persistApprovalAudit(
		name: string,
		args: Record<string, unknown>,
		decision: ApprovalDecision,
	): Promise<void> {
		if (!this.session) return;
		const audit = this.plugin.storage.makeCustomEntry(
			'approval',
			{
				tool: name,
				decision: decision.approved ? 'approved' : 'rejected',
				scope: decision.scope,
				args,
			},
			this.session.leafId,
		);
		await this.plugin.storage.appendEntry(this.session, audit);
	}

}

interface TurnUsage {
	promptTokens: number;
	completionTokens: number;
	cachedTokens?: number;
}
