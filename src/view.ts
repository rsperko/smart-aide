import { ItemView, MarkdownRenderChild, MarkdownRenderer, Notice, Platform, TFile, WorkspaceLeaf, parseLinktext, setIcon } from 'obsidian';
import { TOOLS } from './tools';
import { ChatSession } from './storage';
import { bumpRecent, friendlyModelName } from './models';
import { ModelPickerModal } from './picker-models';
import { NotePickerModal } from './picker-notes';
import type { Skill } from './skills';
import { RenameChatModal } from './modal-rename-chat';
import { PinnedContext } from './context-pins';
import { findEndpoint, resolveModelRef, resolveModelRefStrict, toggleFavorite } from './settings';
import {
	Burst,
	ScreenWakeLock,
	TokenBreakdown,
	createLongPressGate,
	createScreenWakeLock,
	estimateEntryTokens,
	estimateTokens,
	formatTokens,
	formatUsageTooltip,
	groupChainIntoBursts,
	loadedSkillNamesOnChain,
	parseSlashInvocation,
	reduceCumulativeUsage,
	safeParse,
} from './view-helpers';
import { ApprovalDecision } from './view-approval';
import { collectApprovals, runOneToolCall } from './assistant-tools';
import { LiveTurnRenderer, LoopHost, runAssistantLoop } from './assistant-loop';
import { TokenPopover } from './token-popover';
import { ComposerController } from './composer-controller';
import {
	addCopyButtons,
	compactInternalLinks,
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
	MessageEntry,
	ModelRef,
} from './types';
import type SmartAidePlugin from './main';

export const CHAT_VIEW_TYPE = 'smart-aide-chat-view';

export class ChatView extends ItemView {
	private plugin: SmartAidePlugin;
	private session: ChatSession | null = null;
	private modelRef: ModelRef;
	private abort: AbortController | null = null;
	private wakeLock: ScreenWakeLock | null = null;
	private approveAllInTurn = false;
	private turnUsageByEntry: Map<string, TurnUsage> = new Map();
	private loadedSkills: string[] = [];
	private pinned: PinnedContext;

	// DOM refs
	private titleBtn!: HTMLButtonElement;
	private modelChip!: HTMLButtonElement;
	private tokenChip!: HTMLButtonElement;
	private tokenPopoverCtl!: TokenPopover;
	private stopBtn!: HTMLButtonElement;
	private streamEl!: HTMLDivElement;
	private contextRowEl!: HTMLDivElement;
	private composerEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private dangerChip: HTMLButtonElement | null = null;
	private attachmentRowEl!: HTMLDivElement;
	private composer!: ComposerController;
	// Per-entry token estimates. Entries are immutable once persisted (Pi format),
	// so we cache by id and skip re-walking message content on every rerender.
	// Cleared on chat switch since other chats' entries are irrelevant.
	private historyTokenByEntry = new Map<string, number>();
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
		this.composer?.closeSlashPopover();
		this.wakeLock?.dispose();
		this.wakeLock = null;
	}

	private ensureWakeLock(): ScreenWakeLock {
		if (this.wakeLock) return this.wakeLock;
		this.wakeLock = createScreenWakeLock({
			navigator: window.navigator as unknown as Parameters<typeof createScreenWakeLock>[0]['navigator'],
			visibility: window.document,
		});
		return this.wakeLock;
	}

	async newChat(): Promise<void> {
		this.abort?.abort();
		this.session = await this.plugin.storage.createChat();
		this.tokenPopoverCtl?.resetCumulative();
		this.historyTokenByEntry.clear();
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

	currentChatPath(): string | null {
		return this.session?.path ?? null;
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
		this.tokenPopoverCtl?.resetCumulative();
		this.historyTokenByEntry.clear();
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
		const titleGate = createLongPressGate({
			holdMs: 600,
			onClick: () => void this.plugin.openChatPicker(),
			onLongPress: () => this.openRenameModal(),
		});
		this.registerDomEvent(this.titleBtn, 'click', (ev: MouseEvent) => {
			if (!titleGate.click()) {
				ev.preventDefault();
				ev.stopPropagation();
			}
		});
		this.registerDomEvent(this.titleBtn, 'contextmenu', (ev: MouseEvent) => {
			ev.preventDefault();
			this.openRenameModal();
		});
		this.registerDomEvent(this.titleBtn, 'pointerdown', () => titleGate.pointerDown());
		this.registerDomEvent(this.titleBtn, 'pointerup', () => titleGate.pointerEnd());
		this.registerDomEvent(this.titleBtn, 'pointerleave', () => titleGate.pointerEnd());
		this.registerDomEvent(this.titleBtn, 'pointercancel', () => titleGate.pointerEnd());

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
			this.composer.tryPinVaultPath(data);
		});

		// Pending image attachments for the next send — chips with thumbnail + remove.
		this.attachmentRowEl = inputWrap.createDiv({ cls: 'vk-attachment-row' });

		this.composerEl = inputWrap.createEl('textarea', {
			cls: 'vk-input',
			placeholder: 'Ask anything about your vault…',
		});
		this.composerEl.rows = 2;
		this.registerDomEvent(this.composerEl, 'keydown', (ev: KeyboardEvent) => {
			// Slash popover, when open, takes precedence over Enter-to-send and
			// over the textarea's default arrow/tab behavior.
			if (this.composer.isSlashOpen() && this.composer.handleSlashPopoverKey(ev)) return;
			if (ev.key === '@' && !ev.isComposing) {
				// Let the @ get typed; open the picker on next tick so cursor is past the @
				window.setTimeout(() => this.openNoteMentionPicker(), 0);
				return;
			}
			if (ev.key !== 'Enter') return;
			if (ev.isComposing) return; // IME composition — never intercept
			if (Platform.isMobile) return; // mobile keyboard Enter inserts newline; tap Send to send
			ev.preventDefault();
			void this.send();
		});
		this.registerDomEvent(this.composerEl, 'input', () => this.composer.autosize());
		this.registerDomEvent(this.composerEl, 'input', () => this.composer.refreshSendState());
		this.registerDomEvent(this.composerEl, 'input', () => void this.refreshTokenChip());
		this.registerDomEvent(this.composerEl, 'input', () => this.composer.updateSlashPopover());

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
				void this.composer.handleDroppedFiles(files);
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
				void this.composer.attachVaultImage(data);
				return;
			}
			if (this.composer.tryPinVaultPath(data)) return;
			this.composer.insertAtCursor(data);
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
			void this.composer.handleDroppedFiles(images as unknown as FileList);
		});

		// Toolbar beneath the textarea: model picker | tokens | spacer | attach | stop | send
		const toolbar = inputWrap.createDiv({ cls: 'vk-toolbar' });

		this.modelChip = toolbar.createEl('button', { cls: 'vk-model-chip', attr: { type: 'button' } });
		this.refreshModelChip();
		this.registerDomEvent(this.modelChip, 'click', () => this.openModelPicker());

		this.tokenChip = toolbar.createEl('button', {
			cls: 'vk-token-chip',
			attr: { type: 'button' },
		});
		this.tokenChip.setAttribute('aria-label', 'Context usage. Click for breakdown.');
		this.tokenPopoverCtl = new TokenPopover(this.tokenChip, {
			computeBreakdownExcludingComposer: () => this.computeContextProjection(),
			composerText: () => this.composerEl?.value ?? '',
			getModelMeta: () => {
				const { endpoint, slug } = resolveModelRef(this.plugin.settings, this.modelRef);
				return endpoint.discoveredModels?.find((m) => m.id === slug);
			},
		});
		this.registerDomEvent(this.tokenChip, 'click', () => this.tokenPopoverCtl.toggle());

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
				void this.composer.handleDroppedFiles(filePicker.files);
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

		this.composer = new ComposerController(
			{
				app: this.app,
				settings: this.plugin.settings,
				skills: this.plugin.skills,
				pinned: this.pinned,
				saveSettings: () => this.plugin.saveSettings(),
				refreshContextChips: () => this.refreshContextChips(),
				refreshTokenChip: () => void this.refreshTokenChip(),
				rerenderStream: () => this.rerenderStream(),
				isStreaming: () => this.abort !== null,
				registerDomEvent: (el, type, cb) => this.registerDomEvent(el, type, cb),
			},
			this.composerEl,
			this.attachmentRowEl,
			this.sendBtn,
		);
		this.composer.refreshAttachmentChips();
	}

	openNoteMentionPicker(): void {
		this.composer.openNoteMentionPicker();
	}

	private refreshModelChip(): void {
		const friendly = friendlyModelName(this.modelRef.slug);
		const endpoint = findEndpoint(this.plugin.settings, this.modelRef.endpointId);
		this.modelChip.empty();
		this.modelChip.removeClass('vk-model-chip-missing');
		if (!endpoint) {
			this.modelChip.addClass('vk-model-chip-missing');
			this.modelChip.createSpan({ cls: 'vk-model-chip-name', text: `⚠ ${friendly}` });
			this.modelChip.createSpan({ cls: 'vk-model-chip-chevron', text: '▾' });
			this.modelChip.title = 'Endpoint was removed — click to pick a model.';
			this.modelChip.setAttribute('aria-label', 'Endpoint removed. Click to pick a model.');
			return;
		}
		this.modelChip.createSpan({ cls: 'vk-model-chip-name', text: friendly });
		this.modelChip.createSpan({ cls: 'vk-model-chip-chevron', text: '▾' });
		this.modelChip.title = `${this.modelRef.slug} · ${endpoint.name}`;
		this.modelChip.setAttribute('aria-label', `Model: ${friendly}. Click to change.`);
	}

	openModelPicker(): void {
		new ModelPickerModal(
			this.app,
			this.plugin.settings.endpoints,
			this.modelRef,
			this.plugin.settings.modelRecents,
			this.plugin.settings.favoriteModels,
			{
				onPick: (picked) => void this.setModel(picked),
				onToggleFavorite: async (ref) => {
					this.plugin.settings.favoriteModels = toggleFavorite(this.plugin.settings.favoriteModels, ref);
					await this.plugin.saveSettings();
				},
			},
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

	private refreshTokenChip(): Promise<void> {
		return this.tokenPopoverCtl ? this.tokenPopoverCtl.refreshChip() : Promise.resolve();
	}

	private invalidateBreakdownCache(): void {
		this.tokenPopoverCtl?.invalidate();
	}

	private closeTokenPopover(): void {
		this.tokenPopoverCtl?.close();
	}

	private async computeContextProjection(): Promise<Omit<TokenBreakdown, 'composer'>> {
		const base = estimateTokens(this.plugin.settings.systemPrompt);
		const vault = estimateTokens(this.plugin.agents.text());
		const skillsManifest = estimateTokens(this.plugin.skills.manifestText());

		let pinned = 0;
		for (const p of this.pinned.list()) {
			const s = await this.pinned.statusOf(p);
			if (s) pinned += s.tokens;
		}

		let skillsLoaded = 0;
		let history = 0;
		if (this.session) {
			const chain = this.plugin.storage.contextChain(this.session);
			for (const e of chain) {
				let cached = this.historyTokenByEntry.get(e.id);
				if (cached === undefined) {
					cached = estimateEntryTokens(e);
					this.historyTokenByEntry.set(e.id, cached);
				}
				if (e.type === 'custom_message') skillsLoaded += cached;
				else history += cached;
			}
		}

		return { base, vault, skillsManifest, pinned, skillsLoaded, history };
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

	refreshProjection(): void {
		this.invalidateBreakdownCache();
		void this.refreshTokenChip();
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
		this.tokenPopoverCtl?.setCumulative(reduceCumulativeUsage(chain));

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
		if (this.composer.editingFromId) {
			const cutIdx = bursts.findIndex((b) => b.user?.id === this.composer.editingFromId);
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

		const hasAnyKey = this.plugin.settings.endpoints.some((e) => Boolean(e.apiKey));
		if (!hasAnyKey) {
			empty.createDiv({ cls: 'vk-empty-text', text: 'Add an API key to start chatting.' });
			empty.createDiv({
				cls: 'vk-empty-sub',
				text: 'Open Settings → Endpoints and paste a key. OpenRouter is the recommended starting point.',
			});
			const action = empty.createEl('button', { cls: 'mod-cta vk-empty-action', text: 'Open settings' });
			this.registerDomEvent(action, 'click', () => this.openPluginSettings());
			return;
		}

		empty.createDiv({ cls: 'vk-empty-text', text: 'Ask anything about your vault.' });
		empty.createDiv({
			cls: 'vk-empty-sub',
			text: 'I can search and read notes, follow backlinks, and propose edits (with your approval).',
		});

		// Meta line that shows "what does the model already see" before turn 1.
		// Pinned notes are intentionally NOT listed here — the context strip above
		// the composer is the source of truth for pins; duplicating them risks
		// going stale on unpin.
		const meta = empty.createDiv({ cls: 'vk-empty-meta' });
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
			compactInternalLinks(div);
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

		// Add Note sits at the start of the row (Copilot pattern) so the empty
		// state reads as "+ Add note" first; pinned chips fall in to its right.
		const addBtn = this.contextRowEl.createEl('button', {
			cls: 'vk-context-add',
			attr: { type: 'button' },
		});
		const addIcon = addBtn.createSpan({ cls: 'vk-context-add-icon' });
		setIcon(addIcon, 'plus');
		addBtn.createSpan({ text: 'Note' });
		addBtn.title = 'Pin a note as context (or type @ in the composer)';
		this.registerDomEvent(addBtn, 'click', () => this.openContextPicker());

		const pinList = this.pinned.list();

		for (const path of pinList) {
			const chip = this.contextRowEl.createEl('button', {
				cls: 'vk-context-chip',
				attr: { type: 'button' },
			});
			const icon = chip.createSpan({ cls: 'vk-context-chip-icon' });
			setIcon(icon, 'file-text');
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
			const icon = chip.createSpan({ cls: 'vk-context-chip-icon' });
			setIcon(icon, 'brain');
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

	private startEditBranch(parentEntry: MessageEntry): void {
		if (!this.session) return;
		this.composer.startEditBranch(parentEntry);
	}

	private async send(): Promise<void> {
		if (!this.session) return;
		const resolved = resolveModelRefStrict(this.plugin.settings, this.modelRef);
		if (!resolved) {
			new Notice('That endpoint was removed. Pick a model to continue this chat.');
			this.openModelPicker();
			return;
		}
		const { endpoint } = resolved;
		const rawText = this.composerEl.value.trim();
		if (!rawText && this.composer.pendingImages.length === 0) return;

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
			if (!text && this.composer.pendingImages.length === 0) return;
		}

		// Resolve parent: branch if editing, else current leaf
		let parentId: string | null;
		if (this.composer.branchFrom) {
			parentId = this.composer.branchParent || null;
			this.composer.finishEditBranch();
		} else {
			parentId = this.session.leafId;
		}

		// Snapshot + clear pending images before composing so a re-entrant click can't double-send.
		const images = this.composer.consumePendingImages();
		this.composer.clearComposerValue();
		this.composer.refreshAttachmentChips();
		this.composer.autosize();
		this.composer.refreshSendState();
		this.composer.closeSlashPopover();

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
		const session = this.session;
		if (!session) return;
		this.abort = new AbortController();
		await runAssistantLoop(this.makeLoopHost(session), allowedTools, this.abort.signal);
	}

	private makeLoopHost(session: ChatSession): LoopHost {
		return {
			session,
			settings: this.plugin.settings,
			storage: this.plugin.storage,
			skills: this.plugin.skills,
			pinned: this.pinned,
			modelRef: this.modelRef,
			composeSystemPrompt: () => this.composeSystemPrompt(),
			newLiveTurn: () => this.makeLiveTurnRenderer(),
			rerenderStream: () => this.rerenderStream(),
			recordTurnUsage: (u) => this.tokenPopoverCtl.addUsage(u),
			collectApprovals: (calls, opts) =>
				collectApprovals(
					{
						registerDomEvent: (el, type, cb) => this.registerDomEvent(el, type, cb),
						streamEl: this.streamEl,
						scrollAfter: () => this.scrollToBottom(),
					},
					calls,
					TOOLS,
					{ app: this.app, metaDir: this.plugin.settings.metaDir },
					{
						autoApproveWrites: this.plugin.settings.autoApproveWrites,
						approveAllInTurn: opts.approveAllInTurn,
						abortSignal: opts.abortSignal,
					},
				),
			runOneToolCall: (name, args, decision, pending) =>
				runOneToolCall(name, args, decision, pending, {
					tools: TOOLS,
					skills: this.plugin.skills,
					toolCtx: { app: this.app, metaDir: this.plugin.settings.metaDir },
					persistAudit: (n, a, d) => this.persistApprovalAudit(n, a, d),
					getLoadedSkillNames: () => loadedSkillNamesOnChain(this.plugin.storage.contextChain(session)),
				}),
			onLoopStart: () => {
				this.stopBtn.show();
				this.sendBtn.hide();
				this.composer.refreshSendState();
				// Keep the screen awake while the model is working. iOS auto-locks
				// within ~30s of idle, which kills the SSE stream mid-response.
				void this.ensureWakeLock().acquire();
			},
			onLoopEnd: () => {
				this.stopBtn.hide();
				this.sendBtn.show();
				this.abort = null;
				this.composer.refreshSendState();
				this.updateTabTitle();
				void this.wakeLock?.release();
			},
		};
	}

	private makeLiveTurnRenderer(): LiveTurnRenderer {
		const liveWrap = this.streamEl.createDiv({ cls: 'vk-msg vk-role-assistant vk-streaming' });
		const liveBody = liveWrap.createDiv({ cls: 'vk-body' });
		const liveText = liveBody.createDiv({ cls: 'vk-text' });
		// Append to one Text node's .data instead of setText(getText() + delta) —
		// the latter is O(n²) on long answers (read full DOM text, concat, write back).
		const liveTextNode = liveText.ownerDocument.createTextNode('');
		liveText.appendChild(liveTextNode);
		const thinking = liveBody.createDiv({ cls: 'vk-thinking' });
		thinking.createSpan({ cls: 'vk-thinking-dot' });
		thinking.createSpan({ cls: 'vk-thinking-dot' });
		thinking.createSpan({ cls: 'vk-thinking-dot' });
		const toolCardEls = new Map<number, HTMLElement>();
		const clearThinking = () => {
			if (thinking.parentElement) thinking.remove();
		};
		return {
			onText: (delta) => {
				clearThinking();
				liveTextNode.data += delta;
				this.scrollToBottom();
			},
			onToolProgress: (index, partial) => {
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
			onUsage: () => {
				// Cumulative + chip refresh lives on the loop host; nothing for
				// the renderer to do per-turn beyond what onText/onToolProgress do.
			},
			end: () => liveWrap.remove(),
			error: (_kind, message) => {
				liveWrap.remove();
				new Notice(message);
			},
		};
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
