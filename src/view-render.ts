import { App, Notice, setIcon } from 'obsidian';
import { ImageBlock, ToolCallBlock, ToolResultBlock } from './types';
import {
	buildResearchHeadline,
	formatArgsInline,
	researchIcon,
	summarizeToolResult,
	tryFormatJson,
	tryParseJSON,
} from './view-helpers';

export function renderResearchChip(
	parent: HTMLElement,
	calls: ToolCallBlock[],
	results: ToolResultBlock[],
	loadedSkills: string[] = [],
	invokedSkill: string | null = null,
): void {
	const chip = parent.createEl('details', { cls: 'vk-research' });
	const summary = chip.createEl('summary', { cls: 'vk-research-summary' });
	summary.createSpan({ cls: 'vk-research-icon', text: researchIcon(calls, invokedSkill) });
	summary.createSpan({
		cls: 'vk-research-headline',
		text: buildResearchHeadline(calls, results, loadedSkills.length, invokedSkill),
	});

	const detail = chip.createDiv({ cls: 'vk-research-detail' });
	if (invokedSkill) {
		const row = detail.createDiv({ cls: 'vk-research-row' });
		row.createSpan({ cls: 'vk-research-call', text: `🪄 invoked /${invokedSkill}` });
	}
	for (const call of calls) {
		const row = detail.createDiv({ cls: 'vk-research-row' });
		row.createSpan({
			cls: 'vk-research-call',
			text: `${call.name}${formatArgsInline(call.arguments)}`,
		});
		const result = results.find((r) => r.toolCallId === call.id);
		if (result) {
			const cls = result.isError ? 'vk-research-result vk-research-error' : 'vk-research-result';
			row.createSpan({ cls, text: `→ ${summarizeToolResult(result.content)}` });
		}
	}
	for (const skill of loadedSkills) {
		const row = detail.createDiv({ cls: 'vk-research-row' });
		row.createSpan({ cls: 'vk-research-call', text: `🧠 loaded skill: ${skill}` });
	}
}

export function renderCitationCard(parent: HTMLElement, result: ToolResultBlock): void {
	const parsed = tryParseJSON(result.content);
	if (!parsed || typeof parsed.path !== 'string') return;

	const path = parsed.path;
	const startLine = typeof parsed.startLine === 'number' ? parsed.startLine : undefined;
	const endLine = typeof parsed.endLine === 'number' ? parsed.endLine : undefined;
	const content = typeof parsed.content === 'string' ? parsed.content : '';

	const headingMatch = content.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
	const heading = headingMatch ? headingMatch[1].trim() : undefined;

	const basename = path.replace(/\.md$/, '');
	const href = heading ? `${basename}#${heading}` : basename;

	const snippetSource = headingMatch
		? content.slice(headingMatch.index! + headingMatch[0].length)
		: content;
	const snippetLine = snippetSource
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !l.startsWith('#'));
	const snippet = snippetLine
		? snippetLine.replace(/^>\s*/, '').replace(/^[*\-+]\s*/, '').replace(/^\d+\.\s*/, '')
		: '';

	const card = parent.createEl('a', {
		cls: 'vk-citation internal-link',
		href: '#',
		attr: { 'data-href': href },
	});

	const top = card.createDiv({ cls: 'vk-citation-top' });
	top.createSpan({ cls: 'vk-citation-icon', text: '📄' });

	const titleEl = top.createSpan({ cls: 'vk-citation-title' });
	titleEl.createSpan({ cls: 'vk-citation-path', text: basename });
	if (heading) {
		titleEl.createSpan({ cls: 'vk-citation-sep', text: ' › ' });
		titleEl.createSpan({ cls: 'vk-citation-heading', text: heading });
	}

	if (startLine !== undefined && endLine !== undefined) {
		top.createSpan({ cls: 'vk-citation-lines', text: `L${startLine}–${endLine}` });
	}

	if (snippet) {
		const snip = card.createDiv({ cls: 'vk-citation-snippet' });
		snip.setText(snippet.length > 140 ? snippet.slice(0, 137) + '…' : snippet);
	}
}

export function renderImageBlock(app: App, parent: HTMLElement, block: ImageBlock): void {
	const wrap = parent.createDiv({ cls: 'vk-image-block' });
	const file = app.vault.getFileByPath(block.path);
	if (!file) {
		wrap.createDiv({ cls: 'vk-image-missing', text: `[image not found: ${block.path}]` });
		return;
	}
	const img = wrap.createEl('img', { cls: 'vk-image' });
	img.src = app.vault.getResourcePath(file);
	img.alt = block.path;
	wrap.createDiv({ cls: 'vk-image-caption', text: block.path.split('/').pop() ?? block.path });
}

export function renderToolCallBlock(parent: HTMLElement, block: ToolCallBlock): void {
	const card = parent.createEl('details', { cls: 'vk-tool-call' });
	const summary = card.createEl('summary', { cls: 'vk-tool-summary' });
	summary.setText(`🔧 ${block.name}${formatArgsInline(block.arguments)}`);
	const argsEl = card.createEl('pre', { cls: 'vk-tool-args' });
	argsEl.setText(JSON.stringify(block.arguments, null, 2));
}

export function renderToolResultBlock(parent: HTMLElement, block: ToolResultBlock): void {
	const card = parent.createEl('details', {
		cls: block.isError ? 'vk-tool-result vk-tool-error' : 'vk-tool-result',
	});
	const summary = card.createEl('summary', { cls: 'vk-tool-summary' });
	summary.setText(block.isError ? `↳ error` : `↳ ${summarizeToolResult(block.content)}`);
	const pre = card.createEl('pre', { cls: 'vk-tool-result-body' });
	const text = tryFormatJson(block.content);
	pre.setText(text.length > 2000 ? text.slice(0, 2000) + '\n…(truncated)' : text);
}

/**
 * Walk a rendered markdown subtree and attach a copy button to each <pre>.
 * Idempotent — won't double-add. Called after MarkdownRenderer.render completes.
 */
export function addCopyButtons(container: HTMLElement): void {
	const pres = container.querySelectorAll('pre');
	pres.forEach((pre) => {
		if (pre.querySelector('.vk-copy-btn')) return;
		pre.addClass('vk-has-copy');
		const btn = pre.createEl('button', { cls: 'vk-copy-btn' });
		setIcon(btn, 'copy');
		btn.setAttribute('aria-label', 'Copy');
		btn.title = 'Copy';
		btn.addEventListener('click', async (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			const code = pre.querySelector('code');
			const text = code ? code.textContent : pre.textContent;
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				new Notice('Copied', 1200);
				const original = btn.getAttribute('aria-label') || 'Copy';
				setIcon(btn, 'check');
				window.setTimeout(() => {
					setIcon(btn, 'copy');
					btn.setAttribute('aria-label', original);
				}, 900);
			} catch {
				new Notice('Copy failed');
			}
		});
	});
}
