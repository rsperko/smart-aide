import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import { ChatStorage } from './storage';
import { ChatView, CHAT_VIEW_TYPE } from './view';
import {
	captureApiKeysToStore,
	chatsDirFor,
	hydrateApiKeysFromStore,
	memoryFileFor,
	migrateSettings,
	skillsDirFor,
	SmartAideSettings,
	stripApiKeysForPersistence,
} from './settings';
import { SmartAideSettingsTab } from './settings-tab';
import { SkillRegistry } from './skills';
import { AgentsMdRegistry } from './agents-md';
import { MemoryRegistry } from './memory';
import { EditSelectionModal } from './modal-edit-selection';
import { ChatPickerModal } from './modal-chat-picker';
import {
	API_KEY_STORE_PREFIX,
	ApiKeyStore,
	createLocalStorageKeyStore,
} from './api-key-store';

export default class SmartAidePlugin extends Plugin {
	settings!: SmartAideSettings;
	storage!: ChatStorage;
	skills!: SkillRegistry;
	agents!: AgentsMdRegistry;
	memory!: MemoryRegistry;
	keyStore!: ApiKeyStore;

	async onload(): Promise<void> {
		// One-line load log so the dev console shows which build is actually running.
		// Pulls the version from manifest.json via Obsidian's plugin manifest API.
		console.log(`[smart-aide] loaded v${this.manifest.version}`);
		await this.loadSettings();
		this.storage = new ChatStorage(this.app.vault, chatsDirFor(this.settings.metaDir));
		this.skills = new SkillRegistry(this.app, skillsDirFor(this.settings.metaDir));
		this.agents = new AgentsMdRegistry(this.app, this.settings.metaDir);
		this.memory = new MemoryRegistry(this.app, this.settings.metaDir);

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addSettingTab(new SmartAideSettingsTab(this.app, this));

		this.addRibbonIcon('message-square', 'smart-aide: new chat', () => this.openNewChat());

		this.addCommand({
			id: 'reload-skills',
			name: 'Reload skills, AGENTS.md & memory',
			callback: async () => {
				await Promise.all([this.skills.load(), this.agents.load(), this.memory.load()]);
				this.refreshOpenViewProjections();
				new Notice(`Loaded ${this.skills.all().length} skills.`);
			},
		});

		this.addCommand({
			id: 'pick-model',
			name: 'Pick model',
			callback: async () => {
				const leaf = (await this.ensureChatLeaf()) as WorkspaceLeaf;
				const view = leaf.view as ChatView;
				view.openModelPicker();
				this.app.workspace.revealLeaf(leaf);
			},
		});

		this.addCommand({
			id: 'mention-note',
			name: 'Mention a note in the chat',
			callback: async () => {
				const leaf = (await this.ensureChatLeaf()) as WorkspaceLeaf;
				const view = leaf.view as ChatView;
				this.app.workspace.revealLeaf(leaf);
				view.openNoteMentionPicker();
			},
		});

		this.addCommand({
			id: 'new-chat',
			name: 'New chat',
			callback: () => this.openNewChat(),
		});

		this.addCommand({
			id: 'resume-chat',
			name: 'Resume chat (picker)',
			callback: () => this.openChatPicker(),
		});

		this.addCommand({
			id: 'edit-selection',
			name: 'Edit selection with AI',
			icon: 'wand-2',
			editorCallback: (editor: Editor, view: MarkdownView) => this.openEditSelection(editor, view),
			hotkeys: [{ modifiers: ['Mod'], key: 'k' }],
		});

		// Right-click in the editor (long-press on mobile) → "Edit with AI"
		// when there's a selection.
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				if (!(view instanceof MarkdownView)) return;
				if (!readSelectionText(editor)) return;
				menu.addItem((item) => {
					item.setTitle('Edit with AI').setIcon('wand').onClick(() => this.openEditSelection(editor, view));
				});
			}),
		);

		// Ensure smart-aide has a tab in the right sidebar so the icon shows up
		// alongside other right-pane plugins (backlinks, outline, etc). Runs once
		// per plugin load; if user closes the tab, it returns next time.
		// Skills + AGENTS.md load here too — `getAbstractFileByPath` returns null
		// until the vault has finished indexing, which is what layout-ready signals.
		this.app.workspace.onLayoutReady(() => {
			// Refresh token projections in open views once the manifest is real —
			// otherwise the chip undercounts until the user nudges it (e.g. adding
			// a pin), then jumps when the catalog/AGENTS finally land in the recompute.
			this.skills.load()
				.then(() => this.refreshOpenViewProjections())
				.catch((e) => console.warn('smart-aide: skill load failed', e));
			this.agents.load()
				.then(() => this.refreshOpenViewProjections())
				.catch((e) => console.warn('smart-aide: AGENTS.md load failed', e));
			this.memory.load()
				.then(() => this.refreshOpenViewProjections())
				.catch((e) => console.warn('smart-aide: memory load failed', e));
			void this.ensureRightSidebarLeaf();
			// Sweep up empty chat files from older builds that persisted on creation.
			void this.storage.cleanupEmptyChats().catch(() => undefined);
		});

		// Defensive: if duplicates appear during runtime (e.g. cross-device workspace
		// sync, manual "Open as new tab"), collapse them as soon as layout changes.
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).length > 1) {
					this.collapseToSingleLeaf();
				}
			}),
		);

		// File-watch AGENTS.md and memory.md so edits made directly in Obsidian
		// flow into the next chat turn without requiring a manual Reload. The
		// path-matching closure reads `this.settings.metaDir` dynamically so a
		// later metaDir change is handled without re-registering listeners.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile) this.maybeReloadWatchedFile(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile) this.maybeReloadWatchedFile(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) this.maybeReloadWatchedFile(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) this.maybeReloadWatchedFile(file.path);
				this.maybeReloadWatchedFile(oldPath);
			}),
		);
	}

	private openEditSelection(editor: Editor, _view: MarkdownView): void {
		const selection = readSelectionText(editor);
		if (!selection.trim()) {
			new Notice('Select some text first.');
			return;
		}
		const documentText = typeof editor.getValue === 'function' ? editor.getValue() : selection;
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		new EditSelectionModal(
			this.app,
			this,
			{
				selection,
				documentText: typeof documentText === 'string' ? documentText : selection,
				from: { line: from.line, ch: from.ch },
				to: { line: to.line, ch: to.ch },
				agentsBody: this.agents.text(),
				memoryBody: this.memory.text(),
			},
			(newText) => {
				editor.replaceSelection(newText);
			},
		).open();
	}

	/**
	 * Reload the matching registry when an event fires for AGENTS.md or
	 * memory.md. No-op for any other path. Each reload triggers an open-view
	 * projection refresh so the token chip + composed-prompt preview reflect
	 * the new content immediately.
	 */
	private maybeReloadWatchedFile(path: string): void {
		const meta = this.settings.metaDir;
		const memoryPath = normalizePath(memoryFileFor(meta));
		const agentsRootPath = normalizePath('AGENTS.md');
		const agentsMetaPath = normalizePath(`${meta}/AGENTS.md`);

		if (path === memoryPath) {
			this.memory.load()
				.then(() => this.refreshOpenViewProjections())
				.catch((e) => console.warn('smart-aide: memory reload failed', e));
			return;
		}
		if (path === agentsRootPath || path === agentsMetaPath) {
			this.agents.load()
				.then(() => this.refreshOpenViewProjections())
				.catch((e) => console.warn('smart-aide: AGENTS reload failed', e));
		}
	}

	/**
	 * Collapse multiple chat leaves to a single one. Prefers a leaf that has an
	 * instantiated ChatView (i.e. one the user is interacting with) over deferred
	 * placeholders. Called at every entry point that touches leaves — plugin load,
	 * open-chat command, and layout-change events.
	 */
	private collapseToSingleLeaf(): WorkspaceLeaf | null {
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (existing.length === 0) return null;
		const keeper = existing.find((l) => l.view instanceof ChatView) ?? existing[0];
		for (const leaf of existing) {
			if (leaf !== keeper) leaf.detach();
		}
		return keeper;
	}

	private async ensureRightSidebarLeaf(): Promise<void> {
		let leaf = this.collapseToSingleLeaf();

		if (!leaf) {
			// Prefer ensureSideLeaf (Obsidian 1.7.2+); fall back for older builds.
			const ws = this.app.workspace as unknown as {
				ensureSideLeaf?: (type: string, side: 'left' | 'right', opts: { active?: boolean; reveal?: boolean }) => Promise<WorkspaceLeaf | null>;
			};
			if (typeof ws.ensureSideLeaf === 'function') {
				leaf = (await ws.ensureSideLeaf(CHAT_VIEW_TYPE, 'right', { active: false, reveal: false })) ?? null;
			} else {
				leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: false });
			}
		}

		// Obsidian defers side-leaf view instantiation until the leaf is shown — this is
		// why the panel picker showed our chat view as a ghost icon with the kebab-case
		// view-type id instead of the proper icon and name. Force-instantiate by setting
		// the view state explicitly. No-op if the view is already a ChatView, so this is
		// safe to run on every plugin load.
		if (leaf && !(leaf.view instanceof ChatView)) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE });
		}
	}

	async loadSettings(): Promise<void> {
		if (!this.keyStore) this.keyStore = createLocalStorageKeyStore(API_KEY_STORE_PREFIX);
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		const migrated = migrateSettings(raw);
		// Hydrate first (store overrides data.json), then capture so any legacy
		// data.json key seeds the store on first load after upgrade.
		this.settings = hydrateApiKeysFromStore(migrated, this.keyStore);
		captureApiKeysToStore(this.settings, this.keyStore);
	}

	async saveSettings(): Promise<void> {
		// Keys live in the per-device store, never in data.json — Obsidian Sync
		// covers the plugins folder by default, and we don't want one device's
		// data.json clobbering another device's keys.
		captureApiKeysToStore(this.settings, this.keyStore);
		await this.saveData(stripApiKeysForPersistence(this.settings));
	}

	refreshDangerChips(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			const view = leaf.view as ChatView;
			view.refreshDangerChip?.();
		}
	}

	refreshOpenViewProjections(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			const view = leaf.view as ChatView;
			view.refreshProjection?.();
		}
	}

	async openNewChat(): Promise<void> {
		const leaf = await this.ensureChatLeaf();
		const view = leaf.view as ChatView;
		await view.newChat();
		this.app.workspace.revealLeaf(leaf);
	}

	async openChatPicker(): Promise<void> {
		const chats = await this.storage.listChats();
		if (chats.length === 0) {
			new Notice('No saved chats yet.');
			return;
		}
		new ChatPickerModal(
			this.app,
			chats,
			async (path) => {
				const leaf = await this.ensureChatLeaf();
				const view = leaf.view as ChatView;
				await view.loadChat(path);
				this.app.workspace.revealLeaf(leaf);
			},
			async (path) => {
				await this.storage.deleteChat(path);
				for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
					const view = leaf.view;
					if (view instanceof ChatView && view.currentChatPath() === path) {
						await view.newChat();
					}
				}
			},
		).open();
	}

	private async ensureChatLeaf(): Promise<WorkspaceLeaf> {
		const keeper = this.collapseToSingleLeaf();
		if (keeper) return keeper;
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		return leaf;
	}
}

/**
 * Read the currently-selected text out of an Obsidian editor.
 *
 * Some user environments have a plugin or wrapper that stringifies a
 * selection-shaped object via its default `toString()` somewhere upstream
 * of `editor.getSelection()`, so getSelection literally returns the string
 * `"[object Object]"` (not the object — the string). A `typeof === 'string'`
 * guard accepts that, so we can't rely on getSelection alone.
 *
 * Resolution: try range-based extraction first (`getCursor` + `getRange`),
 * which goes through a less-wrapped Editor code path. Use getSelection
 * only as a fallback, and reject the known-bad literal string in both
 * paths. If anything looks malformed, log to the console so a user can
 * share what they see and fall back to "Select some text first."
 */
function readSelectionText(editor: Editor): string {
	// Prefer range-based extraction (getCursor + getRange) over getSelection.
	// In some Obsidian environments getSelection returns the literal string
	// "[object Object]" — a plugin or wrapper somewhere stringifies the
	// underlying selection via its default toString. getRange goes through a
	// less-wrapped Editor code path and returns the real text.
	const isBadSentinel = (s: string): boolean => s === '[object Object]';

	try {
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		if (
			from &&
			to &&
			typeof from.line === 'number' &&
			typeof to.line === 'number' &&
			typeof from.ch === 'number' &&
			typeof to.ch === 'number'
		) {
			if (from.line === to.line && from.ch === to.ch) return '';
			const range = editor.getRange(from, to);
			if (typeof range === 'string' && range.length > 0 && !isBadSentinel(range)) {
				return range;
			}
		}
	} catch { /* fall through */ }

	const direct = (editor as unknown as { getSelection: () => unknown }).getSelection();
	if (typeof direct === 'string' && direct.length > 0 && !isBadSentinel(direct)) {
		return direct;
	}
	return '';
}
