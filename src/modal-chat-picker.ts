import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';

export interface ChatPickerItem {
	path: string;
	title: string;
	preview: string;
	mtime: number;
}

export class ChatPickerModal extends FuzzySuggestModal<ChatPickerItem> {
	constructor(
		app: App,
		private chats: ChatPickerItem[],
		private onPick: (path: string) => void,
		private onDelete: (path: string) => Promise<void>,
	) {
		super(app);
		this.setPlaceholder('Select a chat to resume…');
	}

	getItems(): ChatPickerItem[] {
		return this.chats;
	}

	getItemText(item: ChatPickerItem): string {
		return `${item.title} ${item.preview}`;
	}

	renderSuggestion(match: FuzzyMatch<ChatPickerItem>, el: HTMLElement): void {
		const item = match.item;
		el.empty();
		el.addClass('vk-chat-suggestion');
		const top = el.createDiv({ cls: 'vk-chat-suggestion-top' });
		const date = new Date(item.mtime).toISOString().slice(0, 16).replace('T', ' ');
		top.createSpan({ cls: 'vk-chat-suggestion-date', text: date });
		top.createSpan({ cls: 'vk-chat-suggestion-title', text: item.title });
		const delBtn = top.createEl('button', {
			cls: 'vk-chat-suggestion-del',
			text: '×',
			attr: { type: 'button', 'aria-label': 'Delete chat' },
		});
		delBtn.title = 'Delete chat';
		this.wireDeleteButton(delBtn, item, el);
		if (item.preview) {
			el.createDiv({ cls: 'vk-chat-suggestion-preview', text: item.preview });
		}
	}

	private wireDeleteButton(btn: HTMLButtonElement, item: ChatPickerItem, row: HTMLElement): void {
		let confirming = false;
		let resetTimer: number | undefined;
		// FuzzySuggestModal commits selection on pointerdown / mousedown, so the
		// delete button has to swallow those before they bubble.
		const swallow = (ev: Event) => {
			ev.stopPropagation();
			ev.preventDefault();
		};
		btn.addEventListener('pointerdown', swallow);
		btn.addEventListener('mousedown', swallow);
		btn.addEventListener('touchstart', swallow);
		btn.addEventListener('click', async (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			if (!confirming) {
				confirming = true;
				btn.addClass('vk-chat-suggestion-del-confirm');
				btn.setText('delete?');
				resetTimer = window.setTimeout(() => {
					confirming = false;
					btn.removeClass('vk-chat-suggestion-del-confirm');
					btn.setText('×');
				}, 3000);
				return;
			}
			if (resetTimer) window.clearTimeout(resetTimer);
			await this.onDelete(item.path);
			const idx = this.chats.findIndex((c) => c.path === item.path);
			if (idx >= 0) this.chats.splice(idx, 1);
			row.remove();
			if (this.chats.length === 0) this.close();
		});
	}

	onChooseItem(item: ChatPickerItem): void {
		this.onPick(item.path);
	}
}
