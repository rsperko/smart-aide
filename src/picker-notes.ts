import { App, FuzzySuggestModal, TFile } from 'obsidian';

export class NotePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onPick: (file: TFile) => void,
		placeholder = 'Pick a note to mention…',
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'insert as [[wikilink]]' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}
