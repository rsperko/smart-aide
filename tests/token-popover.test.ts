import { describe, expect, it, vi } from 'vitest';
import { TokenPopover, TokenPopoverDeps } from '../src/token-popover';

/**
 * Vitest's default node environment has no HTMLElement, so we hand the popover
 * a stub whose methods are all no-ops. The tests only exercise the popover's
 * internal state (cumulative usage + breakdown cache) — DOM rendering is
 * unobserved here.
 */
function stubChip(): HTMLButtonElement {
	const noop = () => undefined;
	const stub: Record<string, unknown> = {
		empty: noop,
		addClass: noop,
		removeClass: noop,
		createSpan: () => stub,
		setText: noop,
		setAttribute: noop,
		parentElement: null,
	};
	return stub as unknown as HTMLButtonElement;
}

function makeDeps(overrides: Partial<TokenPopoverDeps> = {}): TokenPopoverDeps {
	return {
		computeBreakdownExcludingComposer: async () => ({
			base: 100,
			vault: 0,
			skillsManifest: 0,
			pinned: 0,
			skillsLoaded: 0,
			history: 0,
		}),
		composerText: () => '',
		getModelMeta: () => undefined,
		...overrides,
	};
}

describe('TokenPopover.addUsage', () => {
	it('accumulates prompt + completion tokens across calls', () => {
		const popover = new TokenPopover(stubChip(), makeDeps());
		popover.addUsage({ promptTokens: 100, completionTokens: 20 });
		popover.addUsage({ promptTokens: 50, completionTokens: 10 });
		expect(popover.cumulativeUsage).toEqual({
			prompt: 150,
			completion: 30,
			cached: 0,
		});
	});

	it('sums cached read + write tokens into the single cached field', () => {
		const popover = new TokenPopover(stubChip(), makeDeps());
		popover.addUsage({
			promptTokens: 200,
			completionTokens: 5,
			cachedReadTokens: 120,
			cachedWriteTokens: 60,
		});
		expect(popover.cumulativeUsage.cached).toBe(180);
	});

	it('treats missing cache fields as 0', () => {
		const popover = new TokenPopover(stubChip(), makeDeps());
		popover.addUsage({ promptTokens: 10, completionTokens: 1 });
		expect(popover.cumulativeUsage.cached).toBe(0);
	});
});

describe('TokenPopover.setCumulative / resetCumulative', () => {
	it('setCumulative replaces the running total (for loadChat replay)', () => {
		const popover = new TokenPopover(stubChip(), makeDeps());
		popover.addUsage({ promptTokens: 100, completionTokens: 20 });
		popover.setCumulative({ prompt: 5000, completion: 200, cached: 1000 });
		expect(popover.cumulativeUsage).toEqual({ prompt: 5000, completion: 200, cached: 1000 });
	});

	it('setCumulative stores a copy, not a reference', () => {
		const popover = new TokenPopover(stubChip(), makeDeps());
		const input = { prompt: 10, completion: 5, cached: 0 };
		popover.setCumulative(input);
		input.prompt = 99999;
		expect(popover.cumulativeUsage.prompt).toBe(10);
	});

	it('resetCumulative zeroes everything (for newChat)', () => {
		const popover = new TokenPopover(stubChip(), makeDeps());
		popover.addUsage({ promptTokens: 1000, completionTokens: 100, cachedReadTokens: 50 });
		popover.resetCumulative();
		expect(popover.cumulativeUsage).toEqual({ prompt: 0, completion: 0, cached: 0 });
	});
});

describe('TokenPopover breakdown cache', () => {
	it('refreshChip populates the cache from computeBreakdown on first call', async () => {
		const compute = vi.fn(async () => ({
			base: 50,
			vault: 25,
			skillsManifest: 10,
			pinned: 0,
			skillsLoaded: 0,
			history: 200,
		}));
		const popover = new TokenPopover(stubChip(), makeDeps({ computeBreakdownExcludingComposer: compute }));
		expect(popover.hasCachedBreakdown).toBe(false);
		await popover.refreshChip();
		expect(popover.hasCachedBreakdown).toBe(true);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it('refreshChip reuses the cache on subsequent calls (composer text updates only)', async () => {
		const compute = vi.fn(async () => ({
			base: 50,
			vault: 0,
			skillsManifest: 0,
			pinned: 0,
			skillsLoaded: 0,
			history: 0,
		}));
		const popover = new TokenPopover(stubChip(), makeDeps({ computeBreakdownExcludingComposer: compute }));
		await popover.refreshChip();
		await popover.refreshChip();
		await popover.refreshChip();
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it('invalidate clears the cache so the next refresh recomputes', async () => {
		const compute = vi.fn(async () => ({
			base: 50,
			vault: 0,
			skillsManifest: 0,
			pinned: 0,
			skillsLoaded: 0,
			history: 0,
		}));
		const popover = new TokenPopover(stubChip(), makeDeps({ computeBreakdownExcludingComposer: compute }));
		await popover.refreshChip();
		popover.invalidate();
		expect(popover.hasCachedBreakdown).toBe(false);
		await popover.refreshChip();
		expect(compute).toHaveBeenCalledTimes(2);
	});
});
