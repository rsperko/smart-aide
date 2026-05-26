import { describe, expect, it } from 'vitest';
import { buildOverview, OverviewInput } from '../src/settings-overview';
import { DEFAULT_SETTINGS, OPENROUTER_ID } from '../src/settings';
import type { SmartAideSettings } from '../src/settings';
import type { Endpoint } from '../src/types';

function makeSettings(overrides: Partial<SmartAideSettings> = {}): SmartAideSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

function makeInput(overrides: Partial<OverviewInput> = {}): OverviewInput {
	return {
		settings: makeSettings(),
		installedSkillCount: 0,
		sampleTotal: 6,
		agentsFound: false,
		memoryFound: false,
		...overrides,
	};
}

function connectedEndpoint(over: Partial<Endpoint> = {}): Endpoint {
	return {
		id: OPENROUTER_ID,
		name: 'OpenRouter',
		baseURL: 'https://openrouter.ai/api/v1',
		apiKey: 'sk-or-v1-test',
		models: ['anthropic/claude-sonnet-4.6'],
		lastTest: { ok: true, at: new Date().toISOString() },
		...over,
	};
}

function row(model: ReturnType<typeof buildOverview>, id: string) {
	const r = model.rows.find((row) => row.id === id);
	if (!r) throw new Error(`row not found: ${id}`);
	return r;
}

describe('buildOverview — banner', () => {
	it('fresh install (no key on any endpoint) shows the no-key banner', () => {
		const out = buildOverview(makeInput());
		expect(out.banner?.id).toBe('no-key');
		expect(out.banner?.primaryAction.href).toContain('openrouter.ai');
	});

	it('key present but lastTest.ok=false shows the test-failed banner', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					endpoints: [
						connectedEndpoint({
							lastTest: { ok: false, at: new Date().toISOString(), message: 'auth failed' },
						}),
					],
				}),
			}),
		);
		expect(out.banner?.id).toBe('test-failed');
	});

	it('connected but no favorites shows the no-favorites banner', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					endpoints: [connectedEndpoint()],
					favoriteModels: [],
				}),
			}),
		);
		expect(out.banner?.id).toBe('no-favorites');
	});

	it('connected + favorites pinned → no banner (happy path)', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					endpoints: [connectedEndpoint()],
					favoriteModels: [{ endpointId: OPENROUTER_ID, slug: 'anthropic/claude-sonnet-4.6' }],
					defaultModelRef: { endpointId: OPENROUTER_ID, slug: 'anthropic/claude-sonnet-4.6' },
				}),
			}),
		);
		expect(out.banner).toBeNull();
	});

	it('priority order: no-key beats test-failed beats no-favorites', () => {
		// All three blockers true simultaneously: no key wins.
		const noKey = buildOverview(makeInput());
		expect(noKey.banner?.id).toBe('no-key');

		// Key + failed test + no favorites: test-failed wins over no-favorites.
		const failedTest = buildOverview(
			makeInput({
				settings: makeSettings({
					endpoints: [
						connectedEndpoint({
							lastTest: { ok: false, at: new Date().toISOString() },
						}),
					],
					favoriteModels: [],
				}),
			}),
		);
		expect(failedTest.banner?.id).toBe('test-failed');
	});
});

describe('buildOverview — rows', () => {
	it('emits six rows in fixed order: providers, chatModels, favorites, vaultData, skills, safety', () => {
		const out = buildOverview(makeInput());
		expect(out.rows.map((r) => r.id)).toEqual([
			'providers',
			'chatModels',
			'favorites',
			'vaultData',
			'skills',
			'safety',
		]);
	});

	it('every row carries a scrollTo target matching its section', () => {
		const out = buildOverview(makeInput());
		const expectedTargets: Record<string, string> = {
			providers: 'providers',
			chatModels: 'chatModels',
			favorites: 'chatModels',
			vaultData: 'vaultData',
			skills: 'skills',
			safety: 'safety',
		};
		for (const r of out.rows) {
			expect(r.scrollTo).toBe(expectedTargets[r.id]);
		}
	});
});

describe('buildOverview — providers row', () => {
	it('fresh install: "1 configured · no keys yet"', () => {
		const out = buildOverview(makeInput());
		expect(row(out, 'providers').status).toMatch(/no keys yet/i);
		expect(row(out, 'providers').tone).toBe('warn');
	});

	it('happy: shows endpoint name + model count + tested freshness', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({ endpoints: [connectedEndpoint()] }),
			}),
		);
		const r = row(out, 'providers');
		expect(r.status).toContain('OpenRouter');
		expect(r.status).toMatch(/model/);
		expect(r.tone).toBe('ok');
	});
});

describe('buildOverview — chat model row', () => {
	it('renders "—" when no favorites pinned (default ref is meaningless)', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					endpoints: [connectedEndpoint()],
					favoriteModels: [],
				}),
			}),
		);
		expect(row(out, 'chatModels').status).toBe('—');
	});

	it('renders the friendly model name when default is set + favorited', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					endpoints: [connectedEndpoint()],
					favoriteModels: [{ endpointId: OPENROUTER_ID, slug: 'anthropic/claude-sonnet-4.6' }],
					defaultModelRef: { endpointId: OPENROUTER_ID, slug: 'anthropic/claude-sonnet-4.6' },
				}),
			}),
		);
		// describeModelRef produces "Claude Sonnet 4.6" (or similar friendly form).
		expect(row(out, 'chatModels').status.toLowerCase()).toContain('sonnet');
	});
});

describe('buildOverview — favorites row', () => {
	it('"None pinned" when empty', () => {
		const out = buildOverview(makeInput());
		expect(row(out, 'favorites').status).toBe('None pinned');
		expect(row(out, 'favorites').tone).toBe('warn');
	});

	it('singularizes "1 model pinned"', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					favoriteModels: [{ endpointId: 'x', slug: 'a' }],
				}),
			}),
		);
		expect(row(out, 'favorites').status).toBe('1 model pinned');
	});

	it('pluralizes "5 models pinned"', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({
					favoriteModels: [
						{ endpointId: 'x', slug: 'a' },
						{ endpointId: 'x', slug: 'b' },
						{ endpointId: 'x', slug: 'c' },
						{ endpointId: 'x', slug: 'd' },
						{ endpointId: 'x', slug: 'e' },
					],
				}),
			}),
		);
		expect(row(out, 'favorites').status).toBe('5 models pinned');
	});
});

describe('buildOverview — vault data row', () => {
	it('mentions metaDir + "AGENTS.md found" when agentsFound', () => {
		const out = buildOverview(makeInput({ agentsFound: true }));
		const r = row(out, 'vaultData');
		expect(r.status).toContain('Meta');
		expect(r.status).toContain('AGENTS.md found');
	});

	it('says "no AGENTS.md" when not found', () => {
		const out = buildOverview(makeInput({ agentsFound: false }));
		expect(row(out, 'vaultData').status).toContain('no AGENTS.md');
	});

	it('reflects a non-default metaDir', () => {
		const out = buildOverview(
			makeInput({
				settings: makeSettings({ metaDir: 'sys' }),
				agentsFound: true,
			}),
		);
		expect(row(out, 'vaultData').status).toContain('sys');
	});

	it('appends "memory loaded" when memory is present', () => {
		const out = buildOverview(makeInput({ agentsFound: true, memoryFound: true }));
		expect(row(out, 'vaultData').status).toContain('memory loaded');
	});

	it('omits "memory loaded" when no memory file is present', () => {
		const out = buildOverview(makeInput({ agentsFound: true, memoryFound: false }));
		expect(row(out, 'vaultData').status).not.toContain('memory loaded');
	});
});

describe('buildOverview — skills row', () => {
	it('empty registry + samples available: "0 installed · 6 starters available"', () => {
		const out = buildOverview(
			makeInput({ installedSkillCount: 0, sampleTotal: 6 }),
		);
		expect(row(out, 'skills').status).toBe('0 installed · 6 starters available');
	});

	it('with skills installed: just "N installed"', () => {
		const out = buildOverview(
			makeInput({ installedSkillCount: 8, sampleTotal: 6 }),
		);
		expect(row(out, 'skills').status).toBe('8 installed');
	});

	it('singularizes "1 installed"', () => {
		const out = buildOverview(
			makeInput({ installedSkillCount: 1, sampleTotal: 6 }),
		);
		expect(row(out, 'skills').status).toBe('1 installed');
	});

	it('action label switches to "Install starters" when none installed and starters available', () => {
		const out = buildOverview(
			makeInput({ installedSkillCount: 0, sampleTotal: 6 }),
		);
		expect(row(out, 'skills').actionLabel.toLowerCase()).toContain('install');
	});
});

describe('buildOverview — safety row', () => {
	it('off: "Writes require approval", tone ok', () => {
		const out = buildOverview(
			makeInput({ settings: makeSettings({ autoApproveWrites: false }) }),
		);
		const r = row(out, 'safety');
		expect(r.status).toBe('Writes require approval');
		expect(r.tone).toBe('ok');
	});

	it('on: warning copy + warn tone', () => {
		const out = buildOverview(
			makeInput({ settings: makeSettings({ autoApproveWrites: true }) }),
		);
		const r = row(out, 'safety');
		expect(r.status).toMatch(/auto-approve/i);
		expect(r.tone).toBe('warn');
	});
});
