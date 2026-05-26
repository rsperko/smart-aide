import { describe, expect, it, vi } from 'vitest';
import { SKILLS_TRUST_NOTE, renderSkills } from '../src/settings-skills';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { SectionContext } from '../src/settings-section';

interface CapturedDiv {
	cls?: string;
	text?: string;
	attrs: Record<string, string>;
	children: CapturedDiv[];
}

function recorder(): { root: CapturedDiv; all: CapturedDiv[] } {
	const all: CapturedDiv[] = [];
	const make = (cls?: string, text?: string): CapturedDiv => {
		const node: CapturedDiv = { cls, text, attrs: {}, children: [] };
		all.push(node);
		return node;
	};
	const root = make('root');
	attachStub(root, all);
	return { root, all };
}

function attachStub(node: CapturedDiv, all: CapturedDiv[]): void {
	const stub = node as unknown as Record<string, unknown>;
	stub.empty = () => undefined;
	stub.setText = (t: string) => {
		node.text = t;
	};
	stub.setAttribute = (k: string, v: string) => {
		node.attrs[k] = v;
	};
	stub.addClass = () => undefined;
	stub.removeClass = () => undefined;
	stub.toggleClass = () => undefined;
	stub.addEventListener = () => undefined;
	stub.removeEventListener = () => undefined;
	stub.appendChild = () => undefined;
	stub.querySelector = () => null;
	stub.querySelectorAll = () => [];
	stub.children = node.children;
	stub.classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false };
	const create = (opts: { cls?: string; text?: string } = {}) => {
		const child: CapturedDiv = { cls: opts.cls, text: opts.text, attrs: {}, children: [] };
		all.push(child);
		node.children.push(child);
		attachStub(child, all);
		return child as unknown as HTMLElement;
	};
	stub.createDiv = create;
	stub.createSpan = create;
	stub.createEl = create;
}

function makeCtx(): SectionContext {
	return {
		plugin: {
			settings: DEFAULT_SETTINGS,
			app: { vault: {} } as never,
			skills: { all: () => [] } as never,
			refreshOpenViewProjections: () => undefined,
		} as never,
		redisplay: () => undefined,
		currentRenderGen: () => 1,
		commitDraft: vi.fn(),
		commitImmediately: vi.fn(),
		saveSettings: vi.fn(async () => undefined),
	} as unknown as SectionContext;
}

describe('SKILLS_TRUST_NOTE constant', () => {
	it('warns that skill bodies are trusted prompt content', () => {
		expect(SKILLS_TRUST_NOTE).toMatch(/trusted/i);
		expect(SKILLS_TRUST_NOTE).toMatch(/prompt/i);
	});

	it('directs the user to review skills before installing', () => {
		expect(SKILLS_TRUST_NOTE).toMatch(/review/i);
	});

	it('explains the risk concretely (e.g. tool redirection / instructions)', () => {
		expect(SKILLS_TRUST_NOTE).toMatch(/instruct|redirect|tool/i);
	});
});

describe('renderSkills DOM', () => {
	it('emits a vk-skills-trust-note div containing the trust warning text', () => {
		const { root, all } = recorder();
		renderSkills(root as unknown as HTMLElement, makeCtx());
		const note = all.find((n) => n.cls === 'vk-skills-trust-note');
		expect(note, 'expected a vk-skills-trust-note div in the rendered tree').toBeTruthy();
		expect(note!.text).toBe(SKILLS_TRUST_NOTE);
	});
});
