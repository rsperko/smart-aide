import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MODELS_ANTHROPIC,
	DEFAULT_MODELS_GEMINI,
	DEFAULT_MODELS_OPENAI,
	ENDPOINT_TEMPLATES,
	defaultModelsFor,
} from '../src/modal-add-endpoint';
import { DEFAULT_MODEL_LIST } from '../src/models';
import type { Endpoint } from '../src/types';

function ep(over: Partial<Endpoint>): Endpoint {
	return { id: 'e1', name: 'Test', baseURL: '', apiKey: '', ...over };
}

describe('default model lists are non-empty and slug-shaped', () => {
	it('OpenRouter DEFAULT_MODEL_LIST is the OpenRouter-shaped curated set', () => {
		expect(DEFAULT_MODEL_LIST.length).toBeGreaterThan(3);
		for (const slug of DEFAULT_MODEL_LIST) {
			// OpenRouter slugs are provider-prefixed.
			expect(slug).toMatch(/^[a-z-]+\/[a-z0-9.\-/]+$/);
		}
	});

	it('per-provider lists are non-empty and use bare slugs (no provider prefix)', () => {
		for (const slug of DEFAULT_MODELS_OPENAI) expect(slug).not.toContain('/');
		for (const slug of DEFAULT_MODELS_ANTHROPIC) expect(slug).not.toContain('/');
		for (const slug of DEFAULT_MODELS_GEMINI) expect(slug).not.toContain('/');
		expect(DEFAULT_MODELS_OPENAI.length).toBeGreaterThan(0);
		expect(DEFAULT_MODELS_ANTHROPIC.length).toBeGreaterThan(0);
		expect(DEFAULT_MODELS_GEMINI.length).toBeGreaterThan(0);
	});
});

describe('ENDPOINT_TEMPLATES source-of-truth', () => {
	it('each non-OpenRouter, non-Custom template carries a non-empty models array', () => {
		for (const t of ENDPOINT_TEMPLATES) {
			if (t.name === 'OpenRouter' || t.name === 'Custom') continue;
			expect(t.models, t.name).toBeDefined();
			expect(t.models!.length, t.name).toBeGreaterThan(0);
		}
	});

	it('templates use the shared DEFAULT_MODELS_* constants (single source of truth)', () => {
		const openai = ENDPOINT_TEMPLATES.find((t) => t.name === 'OpenAI')!;
		const anthropicNative = ENDPOINT_TEMPLATES.find((t) => t.name === 'Anthropic (native)')!;
		const gemini = ENDPOINT_TEMPLATES.find((t) => t.name === 'Gemini (native)')!;
		const anthropicCompat = ENDPOINT_TEMPLATES.find((t) => t.name === 'Anthropic (compat)')!;
		expect(openai.models).toEqual(DEFAULT_MODELS_OPENAI);
		expect(anthropicNative.models).toEqual(DEFAULT_MODELS_ANTHROPIC);
		expect(gemini.models).toEqual(DEFAULT_MODELS_GEMINI);
		expect(anthropicCompat.models).toEqual(DEFAULT_MODELS_ANTHROPIC);
	});

	it('protocol field is set only on native templates', () => {
		const nativeNames = new Set(['Anthropic (native)', 'Gemini (native)']);
		for (const t of ENDPOINT_TEMPLATES) {
			if (nativeNames.has(t.name)) {
				expect(t.protocol).toBeDefined();
			} else {
				expect(t.protocol).toBeUndefined();
			}
		}
	});
});

describe('defaultModelsFor dispatch', () => {
	it('returns Anthropic defaults for any baseURL when protocol === "anthropic"', () => {
		expect(defaultModelsFor(ep({ protocol: 'anthropic', baseURL: 'https://api.anthropic.com' }))).toEqual(
			DEFAULT_MODELS_ANTHROPIC,
		);
		// Even on an unusual URL — protocol wins over URL inference.
		expect(defaultModelsFor(ep({ protocol: 'anthropic', baseURL: 'https://proxy.example.com' }))).toEqual(
			DEFAULT_MODELS_ANTHROPIC,
		);
	});

	it('returns Gemini defaults when protocol === "gemini"', () => {
		expect(defaultModelsFor(ep({ protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta' }))).toEqual(
			DEFAULT_MODELS_GEMINI,
		);
	});

	it('infers OpenRouter defaults from baseURL when no protocol is set', () => {
		expect(defaultModelsFor(ep({ baseURL: 'https://openrouter.ai/api/v1' }))).toEqual(DEFAULT_MODEL_LIST);
	});

	it('infers OpenAI defaults from baseURL when no protocol is set', () => {
		expect(defaultModelsFor(ep({ baseURL: 'https://api.openai.com/v1' }))).toEqual(DEFAULT_MODELS_OPENAI);
	});

	it('infers Anthropic compat defaults from baseURL when no protocol is set', () => {
		expect(defaultModelsFor(ep({ baseURL: 'https://api.anthropic.com/v1' }))).toEqual(DEFAULT_MODELS_ANTHROPIC);
	});

	it('returns null for unrecognized baseURL (custom endpoint)', () => {
		expect(defaultModelsFor(ep({ baseURL: 'http://localhost:11434/v1' }))).toBeNull();
		expect(defaultModelsFor(ep({ baseURL: 'https://api.example.com' }))).toBeNull();
		expect(defaultModelsFor(ep({ baseURL: '' }))).toBeNull();
	});

	it('returns a fresh copy each call (callers can mutate without affecting bundled defaults)', () => {
		const a = defaultModelsFor(ep({ protocol: 'anthropic', baseURL: 'x' }))!;
		const b = defaultModelsFor(ep({ protocol: 'anthropic', baseURL: 'x' }))!;
		expect(a).not.toBe(b);
		a.push('mutated');
		expect(b).not.toContain('mutated');
		expect(DEFAULT_MODELS_ANTHROPIC).not.toContain('mutated');
	});
});
