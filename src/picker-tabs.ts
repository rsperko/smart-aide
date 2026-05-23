import { App, FuzzySuggestModal, TFile } from 'obsidian';

/**
 * Picker for files currently open as main-area tabs. Used by the chat's
 * "+ Add" affordance to pin a file into the context preamble.
 */
export class TabPickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private tabs: TFile[],
		private onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Pin an open tab…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'pin' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): TFile[] {
		return this.tabs;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}
