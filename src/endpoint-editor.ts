import { App, Notice, Setting } from 'obsidian';
import { defaultModelsFor } from './modal-add-endpoint';
import { providerFor } from './providers';
import { describeFreshness, hasWorkingDiscovery } from './settings';
import { Endpoint } from './types';

export interface EndpointEditorContext {
	app: App;
	onChange: () => void;
	onDelete: () => void;
	onBack: () => void;
	saveSettings: () => Promise<void>;
}

/**
 * Render the endpoint editor inline into the given container. This is a sub-page
 * pattern, not a modal — the container is the settings tab content area, which
 * is natively scrollable and handles soft-keyboard focus on iOS.
 */
export function renderEndpointEditor(
	container: HTMLElement,
	endpoint: Endpoint,
	ctx: EndpointEditorContext,
): void {
	let autoDiscoverTimer: number | undefined;
	const scheduleAutoDiscover = () => {
		if (autoDiscoverTimer !== undefined) {
			window.clearTimeout(autoDiscoverTimer);
			autoDiscoverTimer = undefined;
		}
		// Capture the config the user just typed. If anything drifts before the
		// timer fires (URL edit, protocol switch, key paste-then-clear) we bail
		// rather than overwrite the new state with a stale discovery result.
		const snapshot = {
			baseURL: endpoint.baseURL,
			protocol: endpoint.protocol,
			apiKey: endpoint.apiKey,
		};
		autoDiscoverTimer = window.setTimeout(async () => {
			autoDiscoverTimer = undefined;
			if (
				endpoint.baseURL !== snapshot.baseURL ||
				endpoint.protocol !== snapshot.protocol ||
				endpoint.apiKey !== snapshot.apiKey
			) return;
			if (!endpoint.apiKey || !endpoint.baseURL) return;
			try {
				const models = await providerFor(endpoint).discoverModels(endpoint);
				const now = new Date().toISOString();
				endpoint.discoveredModels = models;
				endpoint.discoveredAt = now.slice(0, 19);
				// lastTest is owned by the Test button (which uses
				// testConnection — protocol-aware liveness probe). Auto-discover
				// only touches the model catalog so its results never overwrite
				// the connection-status verdict.
				await ctx.saveSettings();
				ctx.onChange();
			} catch {
				// Silent — user can still inspect via the Test button.
			}
		}, 1500);
	};

	// Sub-page header: back button + provider name as the page title
	const header = container.createDiv({ cls: 'vk-subpage-header' });
	const backBtn = header.createEl('button', { cls: 'vk-back-btn' });
	backBtn.setText('← Providers');
	backBtn.addEventListener('click', () => ctx.onBack());

	new Setting(container).setName(endpoint.name || 'Provider').setHeading();

	new Setting(container).setName('Name').addText((t) =>
		t.setValue(endpoint.name).onChange((v) => {
			endpoint.name = v.trim() || endpoint.id;
			void ctx.saveSettings();
		}),
	);

	new Setting(container)
		.setName('Protocol')
		.setDesc(
			'OpenAI-compatible: POSTs /chat/completions (default — works for OpenRouter, OpenAI, local servers, and any OpenAI-compat gateway). ' +
				'Anthropic (native): uses /v1/messages — required for prompt caching; also the right pick for Anthropic-compatible gateways. ' +
				'Gemini (native): Google AI Studio at /v1beta/models/*:streamGenerateContent — long context + implicit caching. Vertex AI is a different protocol and isn\u2019t supported here; use the OpenAI-compat path through a gateway instead.',
		)
		.addDropdown((dd) =>
			dd
				.addOption('openai-compat', 'OpenAI-compatible')
				.addOption('anthropic', 'Anthropic (native)')
				.addOption('gemini', 'Gemini (native)')
				.setValue(endpoint.protocol ?? 'openai-compat')
				.onChange((v) => {
					const next: typeof endpoint.protocol =
						v === 'anthropic' ? 'anthropic' : v === 'gemini' ? 'gemini' : 'openai-compat';
					if (next !== (endpoint.protocol ?? 'openai-compat')) {
						// Different protocols speak different wire shapes; a discovery
						// or test result from the previous protocol is no longer
						// meaningful and would mislead the user.
						endpoint.discoveredModels = undefined;
						endpoint.discoveredAt = undefined;
						endpoint.lastTest = undefined;
					}
					endpoint.protocol = next;
					void ctx.saveSettings();
					ctx.onChange();
				}),
		);

	const urlFieldFor = (p: Endpoint['protocol']) => {
		if (p === 'anthropic') {
			return {
				label: 'Anthropic API URL',
				placeholder: 'https://api.anthropic.com',
				desc:
					'Root URL of the Anthropic API. Direct: https://api.anthropic.com. ' +
					'Gateway: the gateway\u2019s Anthropic mount (e.g. https://gateway.example/apis/anthropic). ' +
					'We append /v1/messages and /v1/models. Same value as the anthropic SDK\u2019s base_url.',
			};
		}
		if (p === 'gemini') {
			return {
				label: 'Google AI Studio API URL',
				placeholder: 'https://generativelanguage.googleapis.com',
				desc:
					'Root URL of the Google AI Studio API. Direct: https://generativelanguage.googleapis.com. ' +
					'We append /v1beta/models and /v1beta/models/{model}:streamGenerateContent. Same value as the google-genai SDK\u2019s base_url.',
			};
		}
		return {
			label: 'OpenAI API URL',
			placeholder: 'https://api.openai.com/v1',
			desc:
				'Root URL of the OpenAI-compatible API, including /v1. Direct: https://api.openai.com/v1. ' +
				'OpenRouter: https://openrouter.ai/api/v1. We append /chat/completions and /models.',
		};
	};

	const computedCallsFor = (baseURL: string, p: Endpoint['protocol']): string => {
		const base = (baseURL || '').replace(/\/$/, '');
		if (!base) return '';
		if (p === 'anthropic') return `${base}/v1/messages`;
		if (p === 'gemini') return `${base}/v1beta/models/{model}:streamGenerateContent`;
		return `${base}/chat/completions`;
	};

	const urlField = urlFieldFor(endpoint.protocol);
	let urlPreviewEl: HTMLDivElement | undefined;
	new Setting(container)
		.setName(urlField.label)
		.setDesc(urlField.desc)
		.addText((t) =>
			t
				.setPlaceholder(urlField.placeholder)
				.setValue(endpoint.baseURL)
				.onChange((v) => {
					endpoint.baseURL = v.trim();
					refreshKeyHint();
					refreshUrlPreview();
					void ctx.saveSettings();
				}),
		);
	urlPreviewEl = container.createDiv({ cls: 'vk-url-preview' });
	const refreshUrlPreview = () => {
		if (!urlPreviewEl) return;
		urlPreviewEl.empty();
		const calls = computedCallsFor(endpoint.baseURL, endpoint.protocol);
		if (!calls) return;
		urlPreviewEl.createSpan({ cls: 'vk-url-preview-label', text: 'Calls: ' });
		urlPreviewEl.createSpan({ cls: 'vk-url-preview-value', text: calls });
	};
	refreshUrlPreview();

	let apiKeyInput: HTMLInputElement | undefined;
	new Setting(container)
		.setName('API key')
		.addText((t) => {
			apiKeyInput = t.inputEl;
			apiKeyInput.type = 'password';
			apiKeyInput.autocomplete = 'off';
			t.setValue(endpoint.apiKey).onChange((v) => {
				endpoint.apiKey = v.trim();
				refreshKeyHint();
				void ctx.saveSettings();
				scheduleAutoDiscover();
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

	const keyHint = container.createDiv({ cls: 'vk-key-hint' });
	const refreshKeyHint = () => {
		keyHint.empty();
		if (endpoint.apiKey) return;
		const help = keyHelpFor(endpoint.baseURL);
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
	refreshKeyHint();

	// Test connection row
	const testSetting = new Setting(container)
		.setName('Test connection')
		.setDesc('Probes the endpoint. Tells you whether the URL + key work.');

	const statusEl = testSetting.controlEl.createSpan({ cls: 'vk-test-status' });
	if (endpoint.lastTest) {
		const t = endpoint.lastTest;
		statusEl.setText(`${t.ok ? '✓' : '✗'} ${t.message ?? (t.ok ? 'OK' : 'failed')}`);
		statusEl.addClass(t.ok ? 'vk-test-ok' : 'vk-test-bad');
	}

	testSetting.addButton((btn) =>
		btn.setButtonText('Test').onClick(async () => {
			btn.setButtonText('Testing…').setDisabled(true);
			statusEl.setText('');
			statusEl.removeClass('vk-test-ok', 'vk-test-bad');
			try {
				const provider = providerFor(endpoint);
				const result = provider.testConnection
					? await provider.testConnection(endpoint)
					: { message: `${(await provider.discoverModels(endpoint)).length} models` };
				const msg = result.message;
				statusEl.setText(`✓ ${msg}`);
				statusEl.addClass('vk-test-ok');
				endpoint.lastTest = { ok: true, at: new Date().toISOString(), message: msg };
			} catch (e) {
				const label = testFailureLabel(e as Error);
				statusEl.setText(label);
				statusEl.addClass('vk-test-bad');
				endpoint.lastTest = {
					ok: false,
					at: new Date().toISOString(),
					message: label.replace(/^✗\s*/, ''),
				};
			} finally {
				await ctx.saveSettings();
				btn.setButtonText('Test').setDisabled(false);
			}
		}),
	);

	// Models row — count + Refresh
	const discoveredCount = endpoint.discoveredModels?.length ?? 0;
	const summary = endpoint.discoveredAt
		? `${discoveredCount} discovered · ${describeFreshness(endpoint.discoveredAt)}`
		: 'No models discovered yet';

	new Setting(container)
		.setName('Models')
		.setDesc(summary)
		.addButton((btn) =>
			btn
				.setIcon('refresh-cw')
				.setTooltip('Refresh model list')
				.onClick(async () => {
					btn.setDisabled(true);
					try {
						const models = await providerFor(endpoint).discoverModels(endpoint);
						const now = new Date().toISOString();
						endpoint.discoveredModels = models;
						endpoint.discoveredAt = now.slice(0, 19);
						await ctx.saveSettings();
						new Notice(`Refreshed · ${models.length} models`);
						ctx.onChange();
					} catch (e) {
						// /v1/models can fail for two distinct reasons — we must not
						// conflate them by writing failure into lastTest (which Test
						// owns and reflects whether chat works). 404 here typically
						// means the gateway mounts the chat route but not the
						// metadata route — the connection is fine, the catalog isn't
						// exposed. Surface that distinction in the Notice and leave
						// lastTest alone.
						const err = e as Error;
						const msg = err.message || String(err);
						const notice = msg.includes('404')
							? "This endpoint doesn't expose /v1/models. Use the Manual model slugs section below."
							: `Refresh failed: ${msg.slice(0, 100)}`;
						new Notice(notice);
					} finally {
						btn.setDisabled(false);
					}
				}),
		);

	const discoveryWorks = hasWorkingDiscovery(endpoint);
	const manualCount = endpoint.models?.length ?? 0;

	// Manual model list — promoted to top level only when /models discovery has
	// not delivered anything. When discovery works, the manual list is a
	// power-user fallback and lives inside Advanced (below) to reduce noise.
	let manualHost: HTMLElement;
	if (discoveryWorks) {
		const advDetails = container.createEl('details', { cls: 'vk-endpoint-section' });
		const advSummary = advDetails.createEl('summary', { cls: 'vk-endpoint-section-summary' });
		advSummary.setText('Advanced');
		const advBody = advDetails.createDiv({ cls: 'vk-endpoint-section-body' });

		// Manual list — fallback subsection inside Advanced. With /models working,
		// these slugs only matter if you want to expose a model discovery missed.
		manualHost = advBody.createDiv({ cls: 'vk-endpoint-subsection' });
		manualHost.createDiv({ cls: 'vk-endpoint-subsection-title', text: `Manual model slugs${manualCount ? ` · ${manualCount}` : ''}` });
		manualHost.createDiv({
			cls: 'setting-item-description',
			text: 'Add slugs here only if /models discovery missed a model you want available.',
		});
		renderManualListInto(manualHost, endpoint, ctx);

		// Headers — also lives in Advanced.
		const headersHost = advBody.createDiv({ cls: 'vk-endpoint-subsection' });
		headersHost.createDiv({ cls: 'vk-endpoint-subsection-title', text: 'Custom headers' });
		renderHeadersInto(headersHost, endpoint, ctx);
	} else {
		// Discovery didn't deliver — the manual slug list is the only source of
		// available models for this endpoint, so surface it at top level.
		manualHost = container.createDiv({ cls: 'vk-endpoint-manual-primary' });
		manualHost.createDiv({ cls: 'vk-endpoint-section-summary', text: `Manual model slugs${manualCount ? ` (${manualCount})` : ''}` });
		manualHost.createDiv({
			cls: 'setting-item-description',
			text:
				"This endpoint returned no models from /models. That's normal for some gateways — they mount the chat route (e.g. /v1/messages) but not the metadata route. " +
				"Type the slugs you want available, one per line (e.g. claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7).",
		});
		renderManualListInto(manualHost, endpoint, ctx);

		// Headers stays in its own Advanced collapsible.
		const advDetails = container.createEl('details', { cls: 'vk-endpoint-section' });
		const advSummary = advDetails.createEl('summary', { cls: 'vk-endpoint-section-summary' });
		advSummary.setText('Advanced');
		const advBody = advDetails.createDiv({ cls: 'vk-endpoint-section-body' });
		renderHeadersInto(advBody, endpoint, ctx);
	}

	// Delete (two-click confirm)
	const deleteContainer = container.createDiv({ cls: 'vk-subpage-footer' });
	const deleteBtn = deleteContainer.createEl('button', { cls: 'mod-warning', text: 'Delete provider' });
	let confirming = false;
	let resetTimer: number | undefined;
	deleteBtn.addEventListener('click', () => {
		if (!confirming) {
			confirming = true;
			deleteBtn.setText('Click again to confirm');
			resetTimer = window.setTimeout(() => {
				confirming = false;
				deleteBtn.setText('Delete provider');
			}, 3000);
			return;
		}
		if (resetTimer) window.clearTimeout(resetTimer);
		ctx.onDelete();
	});
}

type KeyHelp = { url: string; linkText: string } | { noKey: true };

export function keyHelpFor(baseURL: string): KeyHelp | null {
	const url = baseURL.toLowerCase();
	if (url.includes('openrouter.ai')) return { url: 'https://openrouter.ai/keys', linkText: 'openrouter.ai/keys' };
	if (url.includes('api.openai.com')) return { url: 'https://platform.openai.com/api-keys', linkText: 'platform.openai.com/api-keys' };
	if (url.includes('api.anthropic.com')) return { url: 'https://console.anthropic.com/settings/keys', linkText: 'console.anthropic.com/settings/keys' };
	if (url.includes('generativelanguage.googleapis.com') || url.includes('aistudio.google.com')) {
		return { url: 'https://aistudio.google.com/apikey', linkText: 'aistudio.google.com/apikey' };
	}
	if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0')) return { noKey: true };
	return null;
}

function renderManualListInto(host: HTMLElement, endpoint: Endpoint, ctx: EndpointEditorContext): void {
	const textarea = host.createEl('textarea', { cls: 'vk-settings-textarea' });
	textarea.rows = 6;
	textarea.value = (endpoint.models ?? []).join('\n');
	textarea.addEventListener('input', () => {
		const list = textarea.value
			.split(/[\n,]/)
			.map((s) => s.trim())
			.filter(Boolean);
		endpoint.models = list.length ? list : undefined;
		void ctx.saveSettings();
	});

	const defaults = defaultModelsFor(endpoint);
	const resetRow = host.createDiv({ cls: 'vk-endpoint-reset-row' });
	const resetBtn = resetRow.createEl('button', { text: 'Reset to defaults' });
	if (defaults && defaults.length > 0) {
		resetBtn.title = `Replace the manual list with the ${defaults.length} bundled defaults for this provider.`;
		let armed = false;
		let armTimer: number | undefined;
		const disarm = () => {
			armed = false;
			if (armTimer !== undefined) window.clearTimeout(armTimer);
			armTimer = undefined;
			resetBtn.setText('Reset to defaults');
			resetBtn.removeClass('mod-warning');
		};
		resetBtn.addEventListener('click', () => {
			if (!armed) {
				armed = true;
				resetBtn.setText('Confirm reset');
				resetBtn.addClass('mod-warning');
				armTimer = window.setTimeout(disarm, 3000);
				return;
			}
			disarm();
			endpoint.models = [...defaults];
			textarea.value = defaults.join('\n');
			void ctx.saveSettings();
			ctx.onChange();
			new Notice(`Reset to ${defaults.length} bundled defaults.`);
		});
	} else {
		resetBtn.setAttribute('disabled', 'true');
		resetBtn.title = 'No bundled defaults for this provider — set models manually.';
	}
}

function renderHeadersInto(host: HTMLElement, endpoint: Endpoint, ctx: EndpointEditorContext): void {
	host.createDiv({
		cls: 'setting-item-description',
		text: 'Custom request headers, one per line as "Key: value". For non-standard auth or routing.',
	});
	const textarea = host.createEl('textarea', { cls: 'vk-settings-textarea' });
	textarea.rows = 4;
	textarea.value = Object.entries(endpoint.headers ?? {})
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
		endpoint.headers = Object.keys(headers).length ? headers : undefined;
		void ctx.saveSettings();
	});
}

function testFailureLabel(err: Error): string {
	const msg = err.message || '';
	// Honor specific dual-probe messages from the provider before generic
	// status-code mapping — those messages already explain what's wrong
	// (e.g. "chat blocked at /v1/messages") and shouldn't be flattened to
	// "Wrong URL".
	if (msg.includes('chat blocked')) return `✗ ${msg.slice(0, 120)}`;
	if (msg.includes('401')) return '✗ Bad API key (401)';
	if (msg.includes('403')) return '✗ Forbidden (403)';
	if (msg.includes('404')) return '✗ Wrong URL (404)';
	if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED'))
		return "✗ Couldn't reach the server";
	return `✗ ${msg.slice(0, 80)}`;
}

