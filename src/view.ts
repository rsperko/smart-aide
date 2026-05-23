import { ItemView, MarkdownRenderChild, MarkdownRenderer, Notice, Platform, TFile, WorkspaceLeaf, parseLinktext, setIcon } from 'obsidian';
import { dispatchTool, LOAD_SKILL_NAME, toolsToOpenAI, TOOLS } from './tools';
import { runTurn, streamChat } from './provider';
import { ChatSession, ChatStorage } from './storage';
import { Skill } from './skills';
import { bumpRecent, friendlyModelName } from './models';
import { ModelPickerModal } from './picker-models';
import { NotePickerModal } from './picker-notes';
import { TabPickerModal } from './picker-tabs';
import { RenameChatModal } from './modal-rename-chat';
import { PinnedContext } from './context-pins';
import { findEndpoint, resolveModelRef } from './settings';
import {
	AgentMessage,
	ContentBlock,
	Entry,
	MessageEntry,
	ModelRef,
	OpenAIToolCall,
	Tool,
	ToolCallBlock,
	ToolResultBlock,
} from './types';
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
	private statusEl!: HTMLSpanElement;
	private stopBtn!: HTMLButtonElement;
	private streamEl!: HTMLDivElement;
	private contextRowEl!: HTMLDivElement;
	private composerEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private dangerChip: HTMLButtonElement | null = null;
	private cumulativeTokens = { prompt: 0, completion: 0, cached: 0 };
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
		return this.session?.title || 'Smart Aide';
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
		this.updateStatus();
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
		this.updateStatus();
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

		// Pinned-context chip row — sits above the textarea inside the composer wrap
		// so it visually belongs with the input. Shows files pinned for this chat;
		// content is injected into each user turn as a preamble.
		this.contextRowEl = composerWrap.createDiv({ cls: 'vk-context-row' });
		this.refreshContextChips();

		this.composerEl = composerWrap.createEl('textarea', {
			cls: 'vk-input',
			placeholder: 'Ask anything about your vault…',
		});
		this.composerEl.rows = 2;
		this.registerDomEvent(this.composerEl, 'keydown', (ev: KeyboardEvent) => {
			if (ev.key === '@' && !ev.isComposing) {
				// Let the @ get typed; open the picker on next tick so cursor is past the @
				window.setTimeout(() => this.openNoteMentionPicker(), 0);
				return;
			}
			if (ev.key !== 'Enter') return;
			if (ev.isComposing) return; // IME composition — never intercept
			if (Platform.isMobile) return; // mobile keyboard Enter inserts newline; tap Send to send
			if (ev.shiftKey) return; // Shift+Enter inserts newline on desktop
			ev.preventDefault();
			void this.send();
		});
		this.registerDomEvent(this.composerEl, 'input', () => this.autosizeComposer());
		this.registerDomEvent(this.composerEl, 'input', () => this.updateSendState());

		// Drag-drop: drop a note from the file explorer onto the composer → inserts a wikilink
		this.registerDomEvent(this.composerEl, 'dragover', (ev: DragEvent) => {
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
			ev.preventDefault();
		});
		this.registerDomEvent(this.composerEl, 'drop', (ev: DragEvent) => {
			const data = ev.dataTransfer?.getData('text/plain') || '';
			if (!data) return;
			ev.preventDefault();
			// If it looks like a vault path or wikilink, wrap as [[link]]; otherwise insert as-is.
			let text = data;
			if (!data.startsWith('[[') && (data.endsWith('.md') || this.app.vault.getFileByPath(data))) {
				text = `[[${data.replace(/\.md$/, '')}]]`;
			}
			this.insertAtCursor(text);
		});

		// Toolbar beneath the textarea: model picker | tokens | spacer | stop | send
		const toolbar = composerWrap.createDiv({ cls: 'vk-toolbar' });

		this.modelChip = toolbar.createEl('button', { cls: 'vk-model-chip', attr: { type: 'button' } });
		this.refreshModelChip();
		this.registerDomEvent(this.modelChip, 'click', () => this.openModelPicker());

		this.statusEl = toolbar.createSpan({ cls: 'vk-tokens' });

		toolbar.createDiv({ cls: 'vk-spacer' });

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
		const max = 200;
		const next = Math.min(max, this.composerEl.scrollHeight);
		this.composerEl.style.height = next + 'px';
	}

	openNoteMentionPicker(): void {
		new NotePickerModal(this.app, (file) => this.insertWikilinkFor(file)).open();
	}

	private insertWikilinkFor(file: TFile): void {
		const value = this.composerEl.value;
		const cursor = this.composerEl.selectionStart ?? value.length;
		const wikilink = `[[${file.path.replace(/\.md$/, '')}]]`;
		// If the cursor is just past an `@` (within the last 40 chars without intervening
		// whitespace), replace the `@<query>` with the wikilink.
		const lookback = value.slice(Math.max(0, cursor - 40), cursor);
		const atMatch = lookback.match(/@[^\s]*$/);
		if (atMatch) {
			const atStart = cursor - atMatch[0].length;
			const before = value.slice(0, atStart);
			const after = value.slice(cursor);
			this.composerEl.value = before + wikilink + after;
			const newCursor = (before + wikilink).length;
			this.composerEl.setSelectionRange(newCursor, newCursor);
		} else {
			this.insertAtCursor(wikilink);
			return;
		}
		this.composerEl.focus();
		this.autosizeComposer();
		this.updateSendState();
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
		const empty = this.composerEl.value.trim().length === 0;
		const streaming = this.abort !== null;
		this.sendBtn.disabled = empty || streaming;
	}

	private refreshModelChip(): void {
		const friendly = friendlyModelName(this.modelRef.slug);
		const endpoint = findEndpoint(this.plugin.settings, this.modelRef.endpointId);
		const multi = this.plugin.settings.endpoints.length > 1;
		const label = multi && endpoint ? `${friendly} · ${endpoint.name}` : friendly;
		this.modelChip.empty();
		this.modelChip.createSpan({ cls: 'vk-model-chip-name', text: label });
		this.modelChip.createSpan({ cls: 'vk-model-chip-chevron', text: '▾' });
		this.modelChip.title = `${this.modelRef.slug} (${endpoint?.name ?? this.modelRef.endpointId})`;
		this.modelChip.setAttribute('aria-label', `Model: ${label}. Click to change.`);
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

	private updateStatus(): void {
		const { prompt, completion, cached } = this.cumulativeTokens;
		const total = prompt + completion;
		const parts: string[] = [];
		if (total > 0) {
			parts.push(formatTokens(total));
			if (cached > 0 && prompt > 0) {
				parts.push(`${Math.round((cached / prompt) * 100)}% cached`);
			}
		}
		if (this.loadedSkills.length > 0) {
			parts.push(
				this.loadedSkills.length <= 2
					? `skills: ${this.loadedSkills.join(', ')}`
					: `${this.loadedSkills.length} skills loaded`,
			);
		}
		this.statusEl.setText(parts.join(' · '));
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

		// Rebuild per-turn usage map and loaded-skills list from custom entries in chain
		this.turnUsageByEntry.clear();
		const skills: string[] = [];
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
			} else if (entry.type === 'custom_message' && entry.customType === 'skill') {
				// Display field carries the skill name (e.g. "skill: note-capture")
				const match = entry.display?.match(/skill:\s*(\S+)/);
				if (match) skills.push(match[1]);
			}
		}
		// Dedupe preserving order
		this.loadedSkills = [...new Set(skills)];
		this.updateStatus();

		const messageEntries = chain.filter((e): e is MessageEntry => e.type === 'message');
		if (messageEntries.length === 0) {
			this.renderEmptyState();
			return;
		}

		// When editing a previous user message, render only the chain UP TO (but not
		// including) that message. The message being edited and everything that
		// followed it will be replaced when Send forks; show the user what they're
		// actually committing to.
		let endIndex = messageEntries.length;
		if (this.editingFromId) {
			const cutIdx = messageEntries.findIndex((e) => e.id === this.editingFromId);
			if (cutIdx >= 0) endIndex = cutIdx;
		}

		for (let i = 0; i < endIndex; i++) {
			const entry = messageEntries[i];
			const role = entry.message.role;

			// Tool messages are absorbed into the preceding assistant turn — skip standalone render.
			if (role === 'tool') continue;

			if (role === 'assistant') {
				const calls = extractToolCalls(entry);
				if (calls.length > 0) {
					const next = messageEntries[i + 1];
					const results = next && next.message.role === 'tool'
						? extractToolResults(next)
						: [];
					this.renderAssistantToolTurn(entry, calls, results);
					continue;
				}
			}

			this.renderMessageEntry(entry);
		}
		this.scrollToBottom();
	}

	/**
	 * Render an assistant message that issued tool calls as a compact research chip
	 * followed by any citation cards extracted from the results. Intra-turn narration
	 * ("let me check…") is suppressed — the chip carries the activity.
	 */
	private renderAssistantToolTurn(
		entry: MessageEntry,
		calls: ToolCallBlock[],
		results: ToolResultBlock[],
	): void {
		const wrap = this.streamEl.createDiv({ cls: 'vk-msg vk-role-assistant vk-msg-tool-turn' });
		const body = wrap.createDiv({ cls: 'vk-body' });

		this.renderResearchChip(body, calls, results);

		for (const call of calls) {
			const result = results.find((r) => r.toolCallId === call.id);
			if (!result || result.isError) continue;
			if (call.name === 'read_note') this.renderCitationCard(body, result);
		}

		// Per-turn token info lives in a title tooltip on the wrapper, not a footer.
		const usage = this.turnUsageByEntry.get(entry.id);
		if (usage) wrap.title = formatUsageTooltip(usage);
	}

	private renderResearchChip(
		parent: HTMLElement,
		calls: ToolCallBlock[],
		results: ToolResultBlock[],
	): void {
		const chip = parent.createEl('details', { cls: 'vk-research' });
		const summary = chip.createEl('summary', { cls: 'vk-research-summary' });
		summary.createSpan({ cls: 'vk-research-icon', text: researchIcon(calls) });
		summary.createSpan({ cls: 'vk-research-headline', text: buildResearchHeadline(calls, results) });

		const detail = chip.createDiv({ cls: 'vk-research-detail' });
		for (const call of calls) {
			const row = detail.createDiv({ cls: 'vk-research-row' });
			row.createSpan({
				cls: 'vk-research-call',
				text: `${call.name}${formatArgsInline(call.arguments)}`,
			});
			const result = results.find((r) => r.toolCallId === call.id);
			if (result) {
				const cls = result.isError ? 'vk-research-result vk-research-error' : 'vk-research-result';
				row.createSpan({ cls, text: `→ ${summarizeToolResult(result.content)}` });
			}
		}
	}

	private renderCitationCard(parent: HTMLElement, result: ToolResultBlock): void {
		const parsed = tryParseJSON(result.content);
		if (!parsed || typeof parsed.path !== 'string') return;

		const path = parsed.path;
		const startLine = typeof parsed.startLine === 'number' ? parsed.startLine : undefined;
		const endLine = typeof parsed.endLine === 'number' ? parsed.endLine : undefined;
		const content = typeof parsed.content === 'string' ? parsed.content : '';

		const headingMatch = content.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
		const heading = headingMatch ? headingMatch[1].trim() : undefined;

		const basename = path.replace(/\.md$/, '');
		const href = heading ? `${basename}#${heading}` : basename;

		const snippetSource = headingMatch
			? content.slice(headingMatch.index! + headingMatch[0].length)
			: content;
		const snippetLine = snippetSource
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l.length > 0 && !l.startsWith('#'));
		const snippet = snippetLine
			? snippetLine.replace(/^>\s*/, '').replace(/^[*\-+]\s*/, '').replace(/^\d+\.\s*/, '')
			: '';

		const card = parent.createEl('a', {
			cls: 'vk-citation internal-link',
			href: '#',
			attr: { 'data-href': href },
		});

		const top = card.createDiv({ cls: 'vk-citation-top' });
		top.createSpan({ cls: 'vk-citation-icon', text: '📄' });

		const titleEl = top.createSpan({ cls: 'vk-citation-title' });
		titleEl.createSpan({ cls: 'vk-citation-path', text: basename });
		if (heading) {
			titleEl.createSpan({ cls: 'vk-citation-sep', text: ' › ' });
			titleEl.createSpan({ cls: 'vk-citation-heading', text: heading });
		}

		if (startLine !== undefined && endLine !== undefined) {
			top.createSpan({ cls: 'vk-citation-lines', text: `L${startLine}–${endLine}` });
		}

		if (snippet) {
			const snip = card.createDiv({ cls: 'vk-citation-snippet' });
			snip.setText(snippet.length > 140 ? snippet.slice(0, 137) + '…' : snippet);
		}
	}

	private renderEmptyState(): void {
		const empty = this.streamEl.createDiv({ cls: 'vk-empty' });
		const icon = empty.createDiv({ cls: 'vk-empty-icon' });
		setIcon(icon, 'message-square');
		empty.createDiv({ cls: 'vk-empty-text', text: 'Ask anything about your vault.' });
	}

	private renderMessageEntry(entry: MessageEntry): HTMLElement {
		const m = entry.message;
		const wrap = this.streamEl.createDiv({ cls: `vk-msg vk-role-${m.role}` });

		if (shouldShowRoleLabel(m)) {
			const roleEl = wrap.createDiv({ cls: 'vk-role' });
			roleEl.setText(m.role);
		}

		const body = wrap.createDiv({ cls: 'vk-body' });
		const renderAsMarkdown = m.role === 'assistant' || m.role === 'user';
		if (typeof m.content === 'string') {
			this.renderText(body, m.content, renderAsMarkdown);
		} else {
			for (const block of m.content) {
				if (block.type === 'text') this.renderText(body, block.text, renderAsMarkdown);
				else if (block.type === 'toolCall') this.renderToolCallBlock(body, block);
				else if (block.type === 'toolResult') this.renderToolResultBlock(body, block);
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

	private renderToolCallBlock(parent: HTMLElement, block: ToolCallBlock): void {
		const card = parent.createEl('details', { cls: 'vk-tool-call' });
		const summary = card.createEl('summary', { cls: 'vk-tool-summary' });
		summary.setText(`🔧 ${block.name}${formatArgsInline(block.arguments)}`);
		const argsEl = card.createEl('pre', { cls: 'vk-tool-args' });
		argsEl.setText(JSON.stringify(block.arguments, null, 2));
	}

	private renderToolResultBlock(parent: HTMLElement, block: ToolResultBlock): void {
		const card = parent.createEl('details', {
			cls: block.isError ? 'vk-tool-result vk-tool-error' : 'vk-tool-result',
		});
		const summary = card.createEl('summary', { cls: 'vk-tool-summary' });
		summary.setText(block.isError ? `↳ error` : `↳ ${summarizeToolResult(block.content)}`);
		const pre = card.createEl('pre', { cls: 'vk-tool-result-body' });
		const text = tryFormatJson(block.content);
		pre.setText(text.length > 2000 ? text.slice(0, 2000) + '\n…(truncated)' : text);
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

		for (const path of this.pinned.list()) {
			const chip = this.contextRowEl.createEl('button', {
				cls: 'vk-context-chip',
				attr: { type: 'button' },
			});
			const basename = path.replace(/\.md$/i, '').split('/').pop() ?? path;
			chip.createSpan({ cls: 'vk-context-chip-name', text: basename });
			const tokSpan = chip.createSpan({ cls: 'vk-context-chip-tokens', text: '' });
			void this.pinned.statusOf(path).then((status) => {
				if (!status) return;
				if (status.truncated) {
					chip.addClass('vk-context-chip-truncated');
					tokSpan.setText(` · ${formatTokens(status.tokens)} · truncated`);
					chip.title = `Pinned content capped at ~${Math.round(status.sentBytes / 1000)}KB; full file is ${Math.round(status.totalBytes / 1000)}KB. Use read_note for the rest.`;
				} else if (status.tokens > 0) {
					tokSpan.setText(` · ${formatTokens(status.tokens)}`);
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

		const addBtn = this.contextRowEl.createEl('button', {
			cls: 'vk-context-add',
			attr: { type: 'button' },
			text: '+ Add tab',
		});
		this.registerDomEvent(addBtn, 'click', () => this.openContextPicker());
	}

	private openContextPicker(): void {
		const tabs: TFile[] = [];
		const seen = new Set<string>();
		this.app.workspace.iterateRootLeaves((leaf) => {
			const view = leaf.view as { file?: TFile };
			if (view.file instanceof TFile && view.file.extension === 'md' && !seen.has(view.file.path)) {
				tabs.push(view.file);
				seen.add(view.file.path);
			}
		});
		const available = tabs.filter((t) => !this.pinned.has(t.path));
		if (available.length === 0) {
			new Notice(tabs.length === 0 ? 'No open tabs to pin.' : 'All open tabs are already pinned.');
			return;
		}
		new TabPickerModal(this.app, available, (file) => {
			this.pinned.add(file.path);
			this.refreshContextChips();
		}).open();
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
		const m = parentEntry.message;
		const current = typeof m.content === 'string'
			? m.content
			: (m.content
				.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
				.map((b) => b.text)
				.join(''));
		this.composerEl.value = current;
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
		const text = this.composerEl.value.trim();
		if (!text) return;

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

		this.composerEl.value = '';
		this.autosizeComposer();
		this.updateSendState();

		// Per-turn grants reset at the start of each user turn
		this.approveAllInTurn = false;

		const userMessage: AgentMessage = { role: 'user', content: text };
		const userEntry = this.plugin.storage.makeMessageEntry(userMessage, parentId);
		await this.plugin.storage.appendEntry(this.session, userEntry);
		this.rerenderStream();

		await this.runAssistantLoop();
		void this.maybeAutoTitle();
	}

	private composeSystemPrompt(): string {
		const base = this.plugin.settings.systemPrompt;
		const agentsBody = this.plugin.agents.text();
		const manifest = this.plugin.skills.manifestText();
		const sections = [base];
		if (agentsBody) {
			sections.push(
				`Vault context (user-maintained, from ${this.plugin.settings.metaDir}/AGENTS.md):\n\n${agentsBody}`,
			);
		}
		if (manifest) sections.push(manifest);
		return sections.join('\n\n');
	}

	private async runAssistantLoop(): Promise<void> {
		if (!this.session) return;

		this.abort = new AbortController();
		this.stopBtn.show();
		this.sendBtn.hide();
		this.updateSendState();

		let hitTurnCap = false;
		try {
			for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
				const messages = this.plugin.storage.toOpenAIMessages(
					this.session,
					this.composeSystemPrompt(),
				);

				// Inject pinned-context preamble into the most recent user message so
				// the model can reference open files without a read_note round-trip.
				// Read on each iteration so file edits during the turn show up.
				const preamble = await this.pinned.buildPreamble();
				if (preamble) {
					for (let i = messages.length - 1; i >= 0; i--) {
						const m = messages[i];
						if (m.role === 'user' && typeof m.content === 'string') {
							m.content = `${preamble}\n\n---\n\n${m.content}`;
							break;
						}
					}
				}

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
				let assembled;
				try {
					assembled = await runTurn(
						{
							endpoint,
							model: slug,
							messages,
							tools: toolsToOpenAI(TOOLS),
							signal: this.abort.signal,
						},
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
								this.cumulativeTokens.cached += u.cachedTokens ?? 0;
								this.updateStatus();
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
						name: tc.function.name,
						arguments: safeParse(tc.function.arguments),
					});
				}
				const assistantEntry = this.plugin.storage.makeMessageEntry(
					{ role: 'assistant', content: blocks.length ? blocks : assembled.text || '' },
					this.session.leafId,
				);
				await this.plugin.storage.appendEntry(this.session, assistantEntry);

				// Persist per-turn usage so it can be rendered alongside the assistant message
				if (assembled.usage) {
					const usageEntry = this.plugin.storage.makeCustomEntry(
						'turn-usage',
						{
							targetEntryId: assistantEntry.id,
							promptTokens: assembled.usage.promptTokens,
							completionTokens: assembled.usage.completionTokens,
							cachedTokens: assembled.usage.cachedTokens,
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

				// Execute tool calls. Write/delete tools require user approval first.
				const resultBlocks: ContentBlock[] = [];
				for (const tc of assembled.toolCalls) {
					const args = safeParse(tc.function.arguments);
					const out = await this.dispatchWithApproval(tc.function.name, args);
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
	 * Dispatch a tool call. Write/delete tools route through the approval card UI;
	 * load_skill is handled inline because it needs access to the skill registry and
	 * persists the body as a custom_message entry.
	 */
	private async dispatchWithApproval(name: string, args: Record<string, unknown>): Promise<string> {
		if (!this.session) return JSON.stringify({ error: 'no session' });

		if (name === LOAD_SKILL_NAME) {
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

		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` });

		if (tool.risk === 'write' || tool.risk === 'delete') {
			let preview;
			try {
				preview = tool.preview ? await tool.preview(args, { app: this.app, metaDir: this.plugin.settings.metaDir }) : { summary: `${name}(${Object.keys(args).join(', ')})` };
			} catch (e) {
				preview = { summary: `${name} — preview failed: ${(e as Error).message}` };
			}

			let decision: ApprovalDecision;
			if (this.abort?.signal.aborted) {
				// Stop was hit before we even got here in this dispatch batch.
				decision = { approved: false, reason: 'Stopped by user.' };
			} else if (this.plugin.settings.autoApproveWrites && tool.risk === 'write') {
				// User opted into dangerous mode — writes bypass the approval card.
				// Delete still requires explicit confirmation regardless.
				decision = { approved: true, scope: 'inherited-turn' };
			} else if (this.approveAllInTurn && tool.risk === 'write') {
				// Honor turn-scoped grant for writes only — deletes always confirm
				decision = { approved: true, scope: 'inherited-turn' };
			} else {
				decision = await this.requestApproval(tool, preview, this.abort?.signal);
			}

			// Persist the decision as a custom entry (audit trail)
			const audit = this.plugin.storage.makeCustomEntry(
				'approval',
				{ tool: name, decision: decision.approved ? 'approved' : 'rejected', scope: decision.scope, args },
				this.session.leafId,
			);
			await this.plugin.storage.appendEntry(this.session, audit);

			if (!decision.approved) {
				return JSON.stringify({ status: 'denied', reason: decision.reason ?? 'User rejected the operation.' });
			}
			if (decision.scope === 'turn') this.approveAllInTurn = true;
		}

		return await dispatchTool(TOOLS, name, args, this.app, this.plugin.settings.metaDir);
	}

	private requestApproval(
		tool: Tool,
		preview: { summary: string; diff?: { kind: 'overwrite' | 'append' | 'delete'; oldContent?: string; newContent?: string; path: string } },
		abortSignal?: AbortSignal,
	): Promise<ApprovalDecision> {
		return new Promise((resolve) => {
			const card = this.streamEl.createDiv({ cls: 'vk-approval vk-approval-pending' });

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
				this.scrollToBottom();
			};

			this.registerDomEvent(rejectBtn, 'click', () => decide({ approved: false, reason: 'User clicked Reject.' }));
			this.registerDomEvent(approveBtn, 'click', () => decide({ approved: true }));
			if (approveAllBtn) {
				this.registerDomEvent(approveAllBtn, 'click', () => decide({ approved: true, scope: 'turn' }));
			}

			if (abortSignal) {
				if (abortSignal.aborted) {
					decide({ approved: false, reason: 'Stopped by user.' }, true);
				} else {
					abortListener = () => decide({ approved: false, reason: 'Stopped by user.' }, true);
					abortSignal.addEventListener('abort', abortListener);
				}
			}

			// The card uses position: sticky so it stays at the bottom of the chat scroll
			// area until the user decides. Notice nudges attention in case the chat panel
			// is scrolled or in the background.
			const label = preview.summary;
			new Notice(`Approval needed: ${label}`, 4000);
		});
	}

	/**
	 * After the first user/assistant exchange completes, generate a 4-8 word title
	 * via a cheap call and persist it as a session_info entry. Idempotent — only
	 * runs when no session_info entry exists yet.
	 */
	private async maybeAutoTitle(): Promise<void> {
		if (!this.session) return;
		// Already titled?
		if (this.session.entries.some((e) => e.type === 'session_info')) return;
		// Need at least one user + one assistant
		const hasUser = this.session.entries.some(
			(e) => e.type === 'message' && e.message.role === 'user',
		);
		const hasAssistant = this.session.entries.some(
			(e) => e.type === 'message' && e.message.role === 'assistant',
		);
		if (!hasUser || !hasAssistant) return;
		const { endpoint: titleEndpoint, slug: titleSlug } = resolveModelRef(
			this.plugin.settings,
			this.plugin.settings.titleModelRef,
		);
		if (!titleEndpoint.apiKey) return;

		try {
			const firstUser = this.session.entries.find(
				(e) => e.type === 'message' && e.message.role === 'user',
			) as MessageEntry | undefined;
			const firstAsst = this.session.entries.find(
				(e) => e.type === 'message' && e.message.role === 'assistant',
			) as MessageEntry | undefined;
			if (!firstUser || !firstAsst) return;

			const userText = typeof firstUser.message.content === 'string'
				? firstUser.message.content
				: firstUser.message.content
					.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
					.map((b) => b.text)
					.join(' ');
			const asstText = typeof firstAsst.message.content === 'string'
				? firstAsst.message.content
				: firstAsst.message.content
					.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
					.map((b) => b.text)
					.join(' ');

			let title = '';
			for await (const ev of streamChat({
				endpoint: titleEndpoint,
				model: titleSlug,
				messages: [
					{
						role: 'system',
						content: [
							'Title this conversation in 4-8 words. Reply with ONLY the title — no quotes, no punctuation.',
							'Style: topic-first, descriptive, not "Discussion about X".',
							'Examples: "Finding the weekly review template", "Recipes with miso paste", "Daily note for May 22".',
						].join('\n'),
					},
					{ role: 'user', content: `User: ${userText.slice(0, 400)}\n\nAssistant: ${asstText.slice(0, 400)}` },
				],
			})) {
				if (ev.type === 'text-delta' && ev.textDelta) title += ev.textDelta;
				if (ev.type === 'error') return;
			}
			title = title.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '');
			if (!title) return;

			const entry = this.plugin.storage.makeTitleEntry(title, this.session.leafId);
			await this.plugin.storage.appendEntry(this.session, entry);
			this.session.title = title;
			this.updateTabTitle();
		} catch (e) {
			console.warn('smart-aide: auto-title failed', e);
		}
	}
}

interface ApprovalDecision {
	approved: boolean;
	scope?: 'turn' | 'inherited-turn';
	reason?: string;
}

interface TurnUsage {
	promptTokens: number;
	completionTokens: number;
	cachedTokens?: number;
}

/**
 * Walk a rendered markdown subtree and attach a copy button to each <pre>.
 * Idempotent — won't double-add. Called after MarkdownRenderer.render completes.
 */
function addCopyButtons(container: HTMLElement): void {
	const pres = container.querySelectorAll('pre');
	pres.forEach((pre) => {
		if (pre.querySelector('.vk-copy-btn')) return;
		pre.addClass('vk-has-copy');
		const btn = pre.createEl('button', { cls: 'vk-copy-btn' });
		setIcon(btn, 'copy');
		btn.setAttribute('aria-label', 'Copy');
		btn.title = 'Copy';
		btn.addEventListener('click', async (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			const code = pre.querySelector('code');
			const text = code ? code.textContent : pre.textContent;
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				new Notice('Copied', 1200);
				const original = btn.getAttribute('aria-label') || 'Copy';
				setIcon(btn, 'check');
				window.setTimeout(() => {
					setIcon(btn, 'copy');
					btn.setAttribute('aria-label', original);
				}, 900);
			} catch {
				new Notice('Copy failed');
			}
		});
	});
}

function renderDiff(parent: HTMLElement, diff: { kind: 'overwrite' | 'append' | 'delete'; oldContent?: string; newContent?: string; path: string }): void {
	if (diff.kind === 'delete') {
		const note = parent.createDiv({ cls: 'vk-diff-note', text: 'This will move the file to trash.' });
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

/**
 * Tiny LCS-based line diff. Returns ops in display order.
 */
function lineDiff(a: string[], b: string[]): { type: 'equal' | 'add' | 'remove'; line: string }[] {
	const m = a.length;
	const n = b.length;
	// LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	const ops: { type: 'equal' | 'add' | 'remove'; line: string }[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
			ops.push({ type: 'equal', line: a[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.push({ type: 'add', line: b[j - 1] });
			j--;
		} else if (i > 0) {
			ops.push({ type: 'remove', line: a[i - 1] });
			i--;
		}
	}
	return ops.reverse();
}

function safeParse(s: string): Record<string, unknown> {
	if (!s) return {};
	try {
		return JSON.parse(s);
	} catch {
		return { _raw: s };
	}
}

function tryFormatJson(s: string): string {
	try {
		return JSON.stringify(JSON.parse(s), null, 2);
	} catch {
		return s;
	}
}

function shouldShowRoleLabel(m: AgentMessage): boolean {
	if (m.role === 'user') return true;
	if (m.role === 'tool') return false;
	if (m.role === 'assistant') {
		if (typeof m.content === 'string') return m.content.trim().length > 0;
		return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
	}
	return true;
}

function formatArgsInline(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	if (entries.length === 0) return '()';
	const parts = entries.map(([k, v]) => `${k}=${formatArgValue(v)}`);
	const joined = parts.join(', ');
	if (joined.length <= 80) return `(${joined})`;
	return `(${joined.slice(0, 77)}…)`;
}

function formatArgValue(v: unknown): string {
	if (typeof v === 'string') return `"${v}"`;
	if (v === null || v === undefined) return String(v);
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return JSON.stringify(v);
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n} tok`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k tok`;
	return `${Math.round(n / 1000)}k tok`;
}

function extractToolCalls(entry: MessageEntry): ToolCallBlock[] {
	const m = entry.message;
	if (typeof m.content === 'string') return [];
	return m.content.filter((b): b is ToolCallBlock => b.type === 'toolCall');
}

function extractToolResults(entry: MessageEntry): ToolResultBlock[] {
	const m = entry.message;
	if (typeof m.content === 'string') return [];
	return m.content.filter((b): b is ToolResultBlock => b.type === 'toolResult');
}

function tryParseJSON(s: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(s);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function researchIcon(calls: ToolCallBlock[]): string {
	const names = new Set(calls.map((c) => c.name));
	if (names.size === 1) {
		if (names.has('read_note')) return '📖';
		if (names.has('list_recent')) return '🕘';
		if (names.has('get_backlinks')) return '🔗';
		if (names.has('load_skill')) return '🧩';
		if (names.has('write_note') || names.has('append_to_note')) return '✎';
		if (names.has('delete_note')) return '🗑';
	}
	return '🔍';
}

function buildResearchHeadline(calls: ToolCallBlock[], results: ToolResultBlock[]): string {
	const counts = new Map<string, number>();
	for (const c of calls) counts.set(c.name, (counts.get(c.name) || 0) + 1);

	const parts: string[] = [];
	for (const [name, count] of counts) parts.push(displayToolName(name, count));

	let totalHits = 0;
	let sawSearch = false;
	for (const r of results) {
		if (r.isError) continue;
		try {
			const p = JSON.parse(r.content);
			if (typeof p.matches === 'number') {
				sawSearch = true;
				totalHits += p.matches;
			}
		} catch {
			// ignore
		}
	}
	if (sawSearch) parts.push(`${totalHits} hit${totalHits === 1 ? '' : 's'}`);

	return parts.join(' · ');
}

function displayToolName(name: string, count: number): string {
	const labels: Record<string, [string, string]> = {
		search_vault: ['search', 'searches'],
		read_note: ['read', 'reads'],
		list_recent: ['listing', 'listings'],
		get_backlinks: ['backlinks', 'backlinks'],
		load_skill: ['skill', 'skills'],
		write_note: ['write', 'writes'],
		append_to_note: ['append', 'appends'],
		delete_note: ['delete', 'deletes'],
	};
	const [sg, pl] = labels[name] ?? [name, name];
	return `${count} ${count === 1 ? sg : pl}`;
}

function formatUsageTooltip(usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string {
	const parts: string[] = [];
	parts.push(`${formatTokens(usage.promptTokens)} in`);
	parts.push(`${formatTokens(usage.completionTokens)} out`);
	if (usage.cachedTokens && usage.cachedTokens > 0) {
		parts.push(`${formatTokens(usage.cachedTokens)} cached`);
	}
	return parts.join(' · ');
}

function summarizeToolResult(content: string): string {
	try {
		const parsed = JSON.parse(content);
		if (parsed.error) {
			const msg = String(parsed.error);
			return `error: ${msg.length > 80 ? msg.slice(0, 77) + '…' : msg}`;
		}
		if (typeof parsed.matches === 'number') {
			const returned = parsed.returned ?? parsed.results?.length ?? parsed.matches;
			const suffix = parsed.deepSearch ? ' (deepSearch)' : '';
			return `${returned} match${returned === 1 ? '' : 'es'}${suffix}`;
		}
		if (parsed.path) {
			if (parsed.truncated) {
				return `truncated ${parsed.path} (${parsed.bytes ?? '?'}B, showing ${parsed.endLine ?? '?'} of ${parsed.totalLines ?? '?'} lines)`;
			}
			if (parsed.startLine !== undefined) {
				return `${parsed.path} lines ${parsed.startLine}-${parsed.endLine}`;
			}
			if (parsed.lines !== undefined) {
				return `${parsed.path} (${parsed.lines} lines)`;
			}
			return parsed.path;
		}
		return `${content.length}B`;
	} catch {
		return `${content.length}B`;
	}
}
