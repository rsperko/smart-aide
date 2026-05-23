import { Notice, Plugin, TFile, WorkspaceLeaf, FuzzySuggestModal } from 'obsidian';
import { ChatStorage } from './storage';
import { ChatView, CHAT_VIEW_TYPE } from './view';
import { migrateSettings, SmartAideSettings, SmartAideSettingsTab } from './settings';
import { SkillRegistry } from './skills';

export default class SmartAidePlugin extends Plugin {
	settings!: SmartAideSettings;
	storage!: ChatStorage;
	skills!: SkillRegistry;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.storage = new ChatStorage(this.app.vault);
		this.skills = new SkillRegistry(this.app);
		// Discover skills in the background — don't block plugin load
		this.skills.load().catch((e) => console.warn('smart-aide: skill load failed', e));

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addSettingTab(new SmartAideSettingsTab(this.app, this));

		this.addRibbonIcon('message-square', 'smart-aide: new chat', () => this.openNewChat());

		this.addCommand({
			id: 'reload-skills',
			name: 'Reload skills',
			callback: async () => {
				await this.skills.load();
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

		// Ensure smart-aide has a tab in the right sidebar so the icon shows up
		// alongside other right-pane plugins (backlinks, outline, etc). Runs once
		// per plugin load; if user closes the tab, it returns next time.
		this.app.workspace.onLayoutReady(() => {
			void this.ensureRightSidebarLeaf();
		});
	}

	private async ensureRightSidebarLeaf(): Promise<void> {
		// Detach any duplicate leaves left behind by prior workspace states (e.g. the
		// vault-keeper → smart-aide rename, or repeated plugin reloads).
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		for (let i = 1; i < existing.length; i++) {
			existing[i].detach();
		}

		let leaf: WorkspaceLeaf | null = existing[0] ?? null;

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

	async onunload(): Promise<void> {
		// Leaves are cleaned up automatically by Obsidian.
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = migrateSettings(raw);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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
		new ChatPickerModal(this.app, chats, async (path) => {
			const leaf = await this.ensureChatLeaf();
			const view = leaf.view as ChatView;
			await view.loadChat(path);
			this.app.workspace.revealLeaf(leaf);
		}).open();
	}

	private async ensureChatLeaf(): Promise<WorkspaceLeaf> {
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		if (existing) return existing;
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		return leaf;
	}
}

interface ChatPickerItem {
	path: string;
	title: string;
	preview: string;
	mtime: number;
}

class ChatPickerModal extends FuzzySuggestModal<ChatPickerItem> {
	constructor(
		app: SmartAidePlugin['app'],
		private chats: ChatPickerItem[],
		private onPick: (path: string) => void,
	) {
		super(app);
		this.setPlaceholder('Select a chat to resume…');
	}

	getItems(): ChatPickerItem[] {
		return this.chats;
	}

	getItemText(item: ChatPickerItem): string {
		// Fuzzy match runs against this — include title + preview so users can find by content
		return `${item.title} ${item.preview}`;
	}

	renderSuggestion(match: import('obsidian').FuzzyMatch<ChatPickerItem>, el: HTMLElement): void {
		const item = match.item;
		el.empty();
		el.addClass('vk-chat-suggestion');
		const top = el.createDiv({ cls: 'vk-chat-suggestion-top' });
		const date = new Date(item.mtime).toISOString().slice(0, 16).replace('T', ' ');
		top.createSpan({ cls: 'vk-chat-suggestion-date', text: date });
		top.createSpan({ cls: 'vk-chat-suggestion-title', text: item.title });
		if (item.preview) {
			el.createDiv({ cls: 'vk-chat-suggestion-preview', text: item.preview });
		}
	}

	onChooseItem(item: ChatPickerItem): void {
		this.onPick(item.path);
	}
}
