import { App, Modal, Notice, Setting } from 'obsidian';
import { classifyUrl, fetchWebPage, fetchYouTube, type WebExtract, type YouTubeExtract } from './url-extract';

export type UrlPinResult =
	| { kind: 'web'; extract: WebExtract }
	| { kind: 'youtube'; extract: YouTubeExtract };

/**
 * Prompt the user for a URL, fetch + extract its content, and hand the result
 * back to the caller for pinning. Web pages and YouTube videos are routed to
 * different extractors. Inline status text replaces the input while fetching;
 * errors stay visible so the user understands why the pin didn't appear.
 */
export class UrlPinModal extends Modal {
	private inputEl!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private fetchBtn!: HTMLButtonElement;
	private busy = false;

	constructor(app: App, private onResolved: (pin: UrlPinResult) => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Pin a URL');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vk-url-pin-modal');

		contentEl.createDiv({
			cls: 'setting-item-description',
			text: 'Paste a web page or YouTube URL. The content is fetched once and pinned for the current chat.',
		});

		new Setting(contentEl).setName('URL').addText((t) => {
			this.inputEl = t.inputEl;
			t.setPlaceholder('https://…');
			t.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
				if (ev.key === 'Enter' && !ev.isComposing) {
					ev.preventDefault();
					void this.confirm();
				} else if (ev.key === 'Escape') {
					if (!this.busy) this.close();
				}
			});
		});

		this.statusEl = contentEl.createDiv({ cls: 'vk-url-pin-status' });

		const footer = contentEl.createDiv({ cls: 'vk-modal-footer' });
		const cancel = footer.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => {
			if (!this.busy) this.close();
		});
		footer.createDiv({ cls: 'vk-spacer' });
		this.fetchBtn = footer.createEl('button', { cls: 'mod-cta', text: 'Fetch & pin' });
		this.fetchBtn.addEventListener('click', () => void this.confirm());

		window.setTimeout(() => this.inputEl.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async confirm(): Promise<void> {
		if (this.busy) return;
		const raw = this.inputEl.value.trim();
		if (!raw) return;
		const { kind, normalized } = classifyUrl(raw);
		if (kind === 'unknown') {
			this.setError("That doesn't look like a URL.");
			return;
		}
		this.setStatus(kind === 'youtube' ? 'Fetching transcript…' : 'Fetching page…');
		this.busy = true;
		this.fetchBtn.disabled = true;
		this.inputEl.disabled = true;
		try {
			if (kind === 'youtube') {
				const extract = await fetchYouTube(normalized);
				this.onResolved({ kind: 'youtube', extract });
			} else {
				const extract = await fetchWebPage(normalized);
				this.onResolved({ kind: 'web', extract });
			}
			this.close();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setError(msg);
			new Notice(`Couldn't pin URL: ${msg}`, 5000);
		} finally {
			this.busy = false;
			this.fetchBtn.disabled = false;
			this.inputEl.disabled = false;
		}
	}

	private setStatus(text: string): void {
		this.statusEl.removeClass('vk-url-pin-error');
		this.statusEl.setText(text);
	}

	private setError(text: string): void {
		this.statusEl.addClass('vk-url-pin-error');
		this.statusEl.setText(text);
	}
}
