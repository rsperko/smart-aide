import { App, Modal, Setting } from 'obsidian';

export class RenameChatModal extends Modal {
	private inputEl!: HTMLInputElement;
	private viewportCleanup: (() => void) | undefined;

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

		this.fitToVisualViewport();

		// Mobile keyboard occlusion fix — explicit scroll of the actual scroll ancestor.
		contentEl.addEventListener('focusin', (ev) => {
			const target = ev.target as HTMLElement | null;
			if (!target || !target.matches('input, textarea')) return;
			window.setTimeout(() => scrollFieldToTop(target), 500);
		});
	}

	private fitToVisualViewport(): void {
		const modalEl = this.contentEl.closest('.modal') as HTMLElement | null;
		if (!modalEl) return;
		const vv = window.visualViewport;
		const apply = () => {
			const h = vv ? vv.height : window.innerHeight;
			const offsetTop = vv ? vv.offsetTop : 0;
			modalEl.style.maxHeight = `${Math.max(h * 0.92, 220)}px`;
			modalEl.style.top = `${offsetTop + h * 0.04}px`;
			modalEl.style.transform = 'translateX(-50%)';
		};
		apply();
		if (vv) {
			vv.addEventListener('resize', apply);
			vv.addEventListener('scroll', apply);
			this.viewportCleanup = () => {
				vv.removeEventListener('resize', apply);
				vv.removeEventListener('scroll', apply);
			};
		}
	}

	onClose(): void {
		if (this.viewportCleanup) {
			this.viewportCleanup();
			this.viewportCleanup = undefined;
		}
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

function scrollFieldToTop(target: HTMLElement): void {
	const scrollContainer = findScrollContainer(target);
	if (!scrollContainer) return;
	const targetRect = target.getBoundingClientRect();
	const containerRect = scrollContainer.getBoundingClientRect();
	const targetInContainer = scrollContainer.scrollTop + (targetRect.top - containerRect.top);
	scrollContainer.scrollTo({ top: Math.max(0, targetInContainer - 24), behavior: 'smooth' });
}

function findScrollContainer(el: HTMLElement): HTMLElement | null {
	let cur: HTMLElement | null = el.parentElement;
	while (cur) {
		const overflowY = window.getComputedStyle(cur).overflowY;
		if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
			return cur;
		}
		cur = cur.parentElement;
	}
	return null;
}
