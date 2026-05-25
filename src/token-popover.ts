import type { TurnUsage } from './providers';
import type { DiscoveredModel } from './types';
import {
	CumulativeUsage,
	TokenBreakdown,
	estimateTokens,
	formatCostUsd,
	formatTokenChip,
	formatTokens,
	sumBreakdown,
} from './view-helpers';

export interface TokenPopoverDeps {
	/** Compute the full breakdown minus the composer field — the popover refills
	 * the composer on every refresh since text-input events are cheap. */
	computeBreakdownExcludingComposer(): Promise<Omit<TokenBreakdown, 'composer'>>;
	composerText(): string;
	getModelMeta(): DiscoveredModel | undefined;
}

/**
 * Owns the bottom-toolbar token chip and its expanded popover. Tracks
 * cumulative session usage internally so the host doesn't have to plumb it
 * back in via every call site.
 *
 * Lifecycle from the host: `invalidate()` after pins/skills/history change;
 * `resetCumulative()` on new chat; `addUsage()` from the assistant-loop's
 * usage callback; `close()` from onClose.
 */
export class TokenPopover {
	private cumulative = { prompt: 0, completion: 0, cached: 0 };
	private cached: Omit<TokenBreakdown, 'composer'> | null = null;
	private popover: HTMLElement | null = null;
	private dismisser: ((ev: MouseEvent) => void) | null = null;

	constructor(private chip: HTMLButtonElement, private deps: TokenPopoverDeps) {}

	get cumulativeUsage(): CumulativeUsage {
		return { ...this.cumulative };
	}

	get hasCachedBreakdown(): boolean {
		return this.cached !== null;
	}

	invalidate(): void {
		this.cached = null;
	}

	resetCumulative(): void {
		this.cumulative = { prompt: 0, completion: 0, cached: 0 };
	}

	setCumulative(u: CumulativeUsage): void {
		this.cumulative = { ...u };
	}

	addUsage(u: TurnUsage): void {
		this.cumulative.prompt += u.promptTokens;
		this.cumulative.completion += u.completionTokens;
		this.cumulative.cached += (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
		void this.refreshChip();
	}

	async refreshChip(): Promise<void> {
		if (!this.cached) {
			this.cached = await this.deps.computeBreakdownExcludingComposer();
		}
		const breakdown: TokenBreakdown = {
			...this.cached,
			composer: estimateTokens(this.deps.composerText()),
		};
		const total = sumBreakdown(breakdown);
		const meta = this.deps.getModelMeta();

		this.chip.empty();
		this.chip.removeClass('vk-token-warn');
		this.chip.removeClass('vk-token-muted');

		const display = formatTokenChip(total, meta?.contextLength);
		if (display.severity === 'warn') this.chip.addClass('vk-token-warn');
		else if (display.severity === 'muted') this.chip.addClass('vk-token-muted');
		if (display.pct) {
			this.chip.createSpan({ cls: 'vk-token-pct', text: display.pct });
		}
		if (display.abs) {
			this.chip.createSpan({
				cls: 'vk-token-abs',
				text: `${display.pct ? ' · ' : ''}${display.abs}`,
			});
		}

		if (this.popover) this.renderInto(this.popover, breakdown);
	}

	toggle(): void {
		if (this.popover) {
			this.close();
			return;
		}
		const parent = this.chip.parentElement;
		if (!parent) return;
		this.popover = parent.createDiv({ cls: 'vk-token-popover' });
		const breakdown = this.currentBreakdown();
		this.renderInto(this.popover, breakdown);
		this.dismisser = (ev: MouseEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (this.popover?.contains(target) || this.chip.contains(target)) return;
			this.close();
		};
		// One tick so the click that opened the popover doesn't immediately close it.
		window.setTimeout(() => {
			if (this.dismisser) document.addEventListener('click', this.dismisser);
		}, 0);
	}

	close(): void {
		if (this.dismisser) {
			document.removeEventListener('click', this.dismisser);
			this.dismisser = null;
		}
		this.popover?.remove();
		this.popover = null;
	}

	private currentBreakdown(): TokenBreakdown | null {
		if (!this.cached) return null;
		return { ...this.cached, composer: estimateTokens(this.deps.composerText()) };
	}

	private renderInto(popover: HTMLElement, breakdown: TokenBreakdown | null): void {
		popover.empty();
		if (!breakdown) {
			popover.setText('Computing…');
			return;
		}
		const total = sumBreakdown(breakdown);
		const meta = this.deps.getModelMeta();

		const header = popover.createDiv({ cls: 'vk-token-popover-header' });
		if (meta?.contextLength) {
			const pct = Math.round((total / meta.contextLength) * 100);
			header.setText(
				`Context window: ${formatTokens(total)} / ${formatTokens(meta.contextLength)} (${pct}%)`,
			);
		} else {
			header.setText(`Projected next turn: ${formatTokens(total)}`);
		}

		const rows = popover.createDiv({ cls: 'vk-token-popover-rows' });
		const addRow = (label: string, tokens: number): void => {
			if (tokens === 0) return;
			const row = rows.createDiv({ cls: 'vk-token-popover-row' });
			row.createSpan({ cls: 'vk-token-popover-label', text: label });
			row.createSpan({ cls: 'vk-token-popover-val', text: formatTokens(tokens) });
		};
		addRow('System prompt', breakdown.base);
		addRow('Vault context (AGENTS)', breakdown.vault);
		addRow('Skill catalog', breakdown.skillsManifest);
		addRow('Pinned notes', breakdown.pinned);
		addRow('Loaded skills', breakdown.skillsLoaded);
		addRow('Chat history', breakdown.history);
		addRow('Composer text', breakdown.composer);

		const footer = popover.createDiv({ cls: 'vk-token-popover-footer' });
		const projection = footer.createDiv({ cls: 'vk-token-popover-projection' });
		const COMPLETION_ESTIMATE = 500;
		const costStr = formatCostUsd(total, COMPLETION_ESTIMATE, meta);
		const tail = costStr ? ` · ${costStr}` : '';
		projection.setText(`Next turn ≈ ${formatTokens(total)}${tail}`);

		if (this.cumulative.prompt + this.cumulative.completion > 0) {
			const cumStr = formatCostUsd(this.cumulative.prompt, this.cumulative.completion, meta);
			const cumTail = cumStr ? ` · ${cumStr}` : '';
			const cacheStr =
				this.cumulative.cached > 0 && this.cumulative.prompt > 0
					? ` · ${Math.round((this.cumulative.cached / this.cumulative.prompt) * 100)}% cached`
					: '';
			footer.createDiv({
				cls: 'vk-token-popover-cumulative',
				text: `Session so far: ${formatTokens(this.cumulative.prompt + this.cumulative.completion)}${cumTail}${cacheStr}`,
			});
		}
	}
}
