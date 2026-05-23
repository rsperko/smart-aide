import { App, Modal, Notice, Setting } from 'obsidian';
import { discoverModels } from './provider';
import { Endpoint } from './types';

export class EndpointEditModal extends Modal {
	private autoDiscoverTimer: number | undefined;
	private viewportCleanup: (() => void) | undefined;

	constructor(
		app: App,
		private endpoint: Endpoint,
		private onChange: () => void,
		private onDelete: () => void,
	) {
		super(app);
	}

	/**
	 * Debounced auto-discovery — fires shortly after the user finishes pasting/typing an API key.
	 * Silent on failure so we don't nag mid-typing; explicit Test/Refresh buttons surface errors.
	 */
	private scheduleAutoDiscover(): void {
		if (this.autoDiscoverTimer !== undefined) {
			window.clearTimeout(this.autoDiscoverTimer);
			this.autoDiscoverTimer = undefined;
		}
		this.autoDiscoverTimer = window.setTimeout(async () => {
			this.autoDiscoverTimer = undefined;
			if (!this.endpoint.apiKey || !this.endpoint.baseURL) return;
			try {
				const models = await discoverModels(this.endpoint);
				const now = new Date().toISOString();
				this.endpoint.discoveredModels = models;
				this.endpoint.discoveredAt = now.slice(0, 19);
				this.endpoint.lastTest = { ok: true, at: now, message: `${models.length} models` };
				this.onChange();
				// Re-render so the Models row shows the new count without forcing a reopen.
				this.render();
			} catch {
				// Silent — user can still inspect via the Test button.
			}
		}, 1500);
	}

	onOpen(): void {
		this.titleEl.setText(this.endpoint.name || 'Endpoint');
		this.contentEl.addClass('vk-endpoint-modal');
		this.render();
		this.wireKeyboardAwareScroll();
		this.fitToVisualViewport();
	}

	/**
	 * Track iOS visualViewport so the outer .modal stays inside the visible area when
	 * the soft keyboard appears. Obsidian's default centers the modal on the layout
	 * viewport, which sits behind the keyboard.
	 */
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

	private wireKeyboardAwareScroll(): void {
		// scrollIntoView is unreliable inside Obsidian's flex modal layout. Compute the
		// exact scroll delta against the actual scrolling ancestor and apply it.
		this.contentEl.addEventListener('focusin', (ev) => {
			const target = ev.target as HTMLElement | null;
			if (!target || !target.matches('input, textarea')) return;
			// Wait for the keyboard animation (iOS ~400-500ms) so visualViewport has resized.
			window.setTimeout(() => scrollFieldToTop(target), 500);
		});
	}

	onClose(): void {
		if (this.autoDiscoverTimer !== undefined) {
			window.clearTimeout(this.autoDiscoverTimer);
			this.autoDiscoverTimer = undefined;
		}
		if (this.viewportCleanup) {
			this.viewportCleanup();
			this.viewportCleanup = undefined;
		}
		this.contentEl.empty();
		this.onChange();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		let keyHint: HTMLDivElement | undefined;
		const refreshKeyHint = () => {
			if (!keyHint) return;
			keyHint.empty();
			if (this.endpoint.apiKey) return;
			const help = keyHelpFor(this.endpoint.baseURL);
			if (!help) return;
			if ('noKey' in help) {
				keyHint.addClass('vk-key-hint-info');
				keyHint.removeClass('vk-key-hint-link');
				keyHint.setText('No API key needed for local endpoints.');
				return;
			}
			keyHint.removeClass('vk-key-hint-info');
			keyHint.addClass('vk-key-hint-link');
			keyHint.createSpan({ text: 'Get a key at ' });
			const link = keyHint.createEl('a', { href: help.url, text: help.linkText });
			link.target = '_blank';
		};

		new Setting(contentEl).setName('Name').addText((t) =>
			t.setValue(this.endpoint.name).onChange((v) => {
				this.endpoint.name = v.trim() || this.endpoint.id;
				this.titleEl.setText(this.endpoint.name);
				this.onChange();
			}),
		);

		new Setting(contentEl)
			.setName('Base URL')
			.setDesc('Include /v1 (or equivalent). No /chat/completions.')
			.addText((t) =>
				t
					.setPlaceholder('https://api.openai.com/v1')
					.setValue(this.endpoint.baseURL)
					.onChange((v) => {
						this.endpoint.baseURL = v.trim();
						refreshKeyHint();
						this.onChange();
					}),
			);

		let apiKeyInput: HTMLInputElement | undefined;
		new Setting(contentEl)
			.setName('API key')
			.addText((t) => {
				apiKeyInput = t.inputEl;
				apiKeyInput.type = 'password';
				apiKeyInput.autocomplete = 'off';
				t.setValue(this.endpoint.apiKey).onChange((v) => {
					this.endpoint.apiKey = v.trim();
					refreshKeyHint();
					this.onChange();
					this.scheduleAutoDiscover();
				});
			})
			.addExtraButton((btn) =>
				btn
					.setIcon('eye')
					.setTooltip('Show / hide API key')
					.onClick(() => {
						if (!apiKeyInput) return;
						const showing = apiKeyInput.type === 'text';
						apiKeyInput.type = showing ? 'password' : 'text';
						btn.setIcon(showing ? 'eye' : 'eye-off');
					}),
			);

		keyHint = contentEl.createDiv({ cls: 'vk-key-hint' });
		refreshKeyHint();

		this.renderTestRow(contentEl);
		this.renderModelsRow(contentEl);
		this.renderManualListSection(contentEl);
		this.renderAdvancedSection(contentEl);
		this.renderFooter(contentEl);
	}

	private renderTestRow(parent: HTMLElement): void {
		const setting = new Setting(parent)
			.setName('Test connection')
			.setDesc('Probes /models. Tells you whether the URL + key work.');

		const statusEl = setting.controlEl.createSpan({ cls: 'vk-test-status' });

		// Surface any prior test result so the user doesn't lose context on modal re-open.
		if (this.endpoint.lastTest) {
			const t = this.endpoint.lastTest;
			statusEl.setText(`${t.ok ? '✓' : '✗'} ${t.message ?? (t.ok ? 'OK' : 'failed')}`);
			statusEl.addClass(t.ok ? 'vk-test-ok' : 'vk-test-bad');
		}

		setting.addButton((btn) =>
			btn.setButtonText('Test').onClick(async () => {
				btn.setButtonText('Testing…').setDisabled(true);
				statusEl.setText('');
				statusEl.removeClass('vk-test-ok', 'vk-test-bad');
				try {
					const models = await discoverModels(this.endpoint);
					const msg = `${models.length} models`;
					statusEl.setText(`✓ ${msg}`);
					statusEl.addClass('vk-test-ok');
					this.endpoint.lastTest = { ok: true, at: new Date().toISOString(), message: msg };
				} catch (e) {
					const label = testFailureLabel(e as Error);
					statusEl.setText(label);
					statusEl.addClass('vk-test-bad');
					this.endpoint.lastTest = { ok: false, at: new Date().toISOString(), message: label.replace(/^✗\s*/, '') };
				} finally {
					this.onChange();
					btn.setButtonText('Test').setDisabled(false);
				}
			}),
		);
	}

	private renderModelsRow(parent: HTMLElement): void {
		const discoveredCount = this.endpoint.discoveredModels?.length ?? 0;
		const summary = this.endpoint.discoveredAt
			? `${discoveredCount} discovered · ${describeFreshness(this.endpoint.discoveredAt)}`
			: 'No models discovered yet';

		new Setting(parent)
			.setName('Models')
			.setDesc(summary)
			.addButton((btn) =>
				btn
					.setIcon('refresh-cw')
					.setTooltip('Refresh model list')
					.onClick(async () => {
						btn.setDisabled(true);
						try {
							const models = await discoverModels(this.endpoint);
							const now = new Date().toISOString();
							this.endpoint.discoveredModels = models;
							this.endpoint.discoveredAt = now.slice(0, 19);
							this.endpoint.lastTest = { ok: true, at: now, message: `${models.length} models` };
							this.onChange();
							new Notice(`Refreshed · ${models.length} models`);
							this.render();
						} catch (e) {
							const label = testFailureLabel(e as Error);
							this.endpoint.lastTest = {
								ok: false,
								at: new Date().toISOString(),
								message: label.replace(/^✗\s*/, ''),
							};
							this.onChange();
							new Notice(`Refresh failed: ${(e as Error).message.slice(0, 100)}`);
							btn.setDisabled(false);
						}
					}),
			);
	}

	private renderManualListSection(parent: HTMLElement): void {
		const manualCount = this.endpoint.models?.length ?? 0;
		const details = parent.createEl('details', { cls: 'vk-endpoint-section' });
		const summary = details.createEl('summary', { cls: 'vk-endpoint-section-summary' });
		summary.setText(`Manual model list${manualCount ? ` (${manualCount})` : ''}`);

		const body = details.createDiv({ cls: 'vk-endpoint-section-body' });
		body.createDiv({
			cls: 'setting-item-description',
			text: 'One slug per line. Use when /models is unavailable or to pin a curated subset.',
		});
		const textarea = body.createEl('textarea', { cls: 'vk-settings-textarea' });
		textarea.rows = 5;
		textarea.value = (this.endpoint.models ?? []).join('\n');
		textarea.addEventListener('input', () => {
			const list = textarea.value
				.split(/[\n,]/)
				.map((s) => s.trim())
				.filter(Boolean);
			this.endpoint.models = list.length ? list : undefined;
			this.onChange();
		});
	}

	private renderAdvancedSection(parent: HTMLElement): void {
		const details = parent.createEl('details', { cls: 'vk-endpoint-section' });
		const summary = details.createEl('summary', { cls: 'vk-endpoint-section-summary' });
		summary.setText('Advanced');

		const body = details.createDiv({ cls: 'vk-endpoint-section-body' });
		body.createDiv({
			cls: 'setting-item-description',
			text: 'Custom request headers, one per line as "Key: value". For non-standard auth or routing.',
		});
		const textarea = body.createEl('textarea', { cls: 'vk-settings-textarea' });
		textarea.rows = 3;
		textarea.value = Object.entries(this.endpoint.headers ?? {})
			.map(([k, v]) => `${k}: ${v}`)
			.join('\n');
		textarea.addEventListener('input', () => {
			const headers: Record<string, string> = {};
			for (const line of textarea.value.split('\n')) {
				const idx = line.indexOf(':');
				if (idx < 1) continue;
				const k = line.slice(0, idx).trim();
				const v = line.slice(idx + 1).trim();
				if (k && v) headers[k] = v;
			}
			this.endpoint.headers = Object.keys(headers).length ? headers : undefined;
			this.onChange();
		});
	}

	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: 'vk-modal-footer' });

		const deleteBtn = footer.createEl('button', { cls: 'mod-warning', text: 'Delete endpoint' });
		let confirming = false;
		let resetTimer: number | undefined;
		deleteBtn.addEventListener('click', () => {
			if (!confirming) {
				confirming = true;
				deleteBtn.setText('Click again to confirm');
				resetTimer = window.setTimeout(() => {
					confirming = false;
					deleteBtn.setText('Delete endpoint');
				}, 3000);
				return;
			}
			if (resetTimer) window.clearTimeout(resetTimer);
			this.onDelete();
			this.close();
		});

		footer.createDiv({ cls: 'vk-spacer' });

		const doneBtn = footer.createEl('button', { cls: 'mod-cta', text: 'Done' });
		doneBtn.addEventListener('click', () => this.close());
	}
}

/**
 * Walk up to the nearest scrolling ancestor and scroll it so `target` lands near
 * the top. More reliable than `scrollIntoView` inside Obsidian's flex modal layout,
 * which sometimes refuses to scroll because the layout assumes the outer element
 * is sized to fit content.
 */
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

type KeyHelp = { url: string; linkText: string } | { noKey: true };

function keyHelpFor(baseURL: string): KeyHelp | null {
	const url = baseURL.toLowerCase();
	if (url.includes('openrouter.ai')) return { url: 'https://openrouter.ai/keys', linkText: 'openrouter.ai/keys' };
	if (url.includes('api.openai.com')) return { url: 'https://platform.openai.com/api-keys', linkText: 'platform.openai.com/api-keys' };
	if (url.includes('api.anthropic.com')) return { url: 'https://console.anthropic.com/settings/keys', linkText: 'console.anthropic.com/settings/keys' };
	if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0')) return { noKey: true };
	return null;
}

function testFailureLabel(err: Error): string {
	const msg = err.message || '';
	if (msg.includes('401')) return '✗ Bad API key (401)';
	if (msg.includes('403')) return '✗ Forbidden (403)';
	if (msg.includes('404')) return '✗ Wrong URL (404)';
	if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED'))
		return "✗ Couldn't reach the server";
	return `✗ ${msg.slice(0, 80)}`;
}

function describeFreshness(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return iso.slice(0, 10);
	const days = Math.floor((Date.now() - then) / 86_400_000);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 30) return `${days} days ago`;
	return iso.slice(0, 10);
}
