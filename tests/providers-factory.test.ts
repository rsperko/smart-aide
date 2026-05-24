import { describe, expect, it } from 'vitest';
import { providerFor } from '../src/providers';
import { anthropicProvider } from '../src/providers/anthropic';
import { geminiProvider } from '../src/providers/gemini';
import { openAICompatProvider } from '../src/providers/openai-compat';
import type { Endpoint } from '../src/types';

function ep(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id: 'e1',
		name: 'Test',
		baseURL: 'https://example.com/v1',
		apiKey: '',
		...overrides,
	};
}

describe('providerFor', () => {
	it('returns the openai-compat provider when protocol is undefined', () => {
		expect(providerFor(ep())).toBe(openAICompatProvider);
	});

	it('returns the openai-compat provider when protocol is "openai-compat"', () => {
		expect(providerFor(ep({ protocol: 'openai-compat' }))).toBe(openAICompatProvider);
	});

	it('returns the anthropic provider when protocol is "anthropic"', () => {
		expect(providerFor(ep({ protocol: 'anthropic' }))).toBe(anthropicProvider);
	});

	it('returns the gemini provider when protocol is "gemini"', () => {
		expect(providerFor(ep({ protocol: 'gemini' }))).toBe(geminiProvider);
	});

	it('advertises caching capability for anthropic and gemini, not for openai-compat', () => {
		expect(openAICompatProvider.capabilities.supportsCachedPrompt).toBe(false);
		expect(anthropicProvider.capabilities.supportsCachedPrompt).toBe(true);
		expect(geminiProvider.capabilities.supportsCachedPrompt).toBe(true);
	});
});
