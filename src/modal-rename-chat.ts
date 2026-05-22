import { App, Modal, Setting } from 'obsidian';

export class RenameChatModal extends Modal {
	private inputEl!: HTMLInputElement;

	constructor(
		app: App,
		private currentTitle: string,
		private onSave: (newTitle: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Rename chat');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vk-rename-modal');

		new Setting(contentEl).setName('Title').addText((t) => {
			this.inputEl = t.inputEl;
			t.setValue(this.currentTitle);
			t.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
				if (ev.key === 'Enter' && !ev.isComposing) {
					ev.preventDefault();
					this.confirm();
				} else if (ev.key === 'Escape') {
					this.close();
				}
			});
		});

		const footer = contentEl.createDiv({ cls: 'vk-modal-footer' });
		const cancel = footer.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		footer.createDiv({ cls: 'vk-spacer' });
		const save = footer.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener('click', () => this.confirm());

		window.setTimeout(() => {
			this.inputEl.focus();
			this.inputEl.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private confirm(): void {
		const value = this.inputEl.value.trim();
		if (!value || value === this.currentTitle) {
			this.close();
			return;
		}
		this.onSave(value);
		this.close();
	}
}
