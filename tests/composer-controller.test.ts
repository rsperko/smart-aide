import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { ComposerController, ComposerHost } from '../src/composer-controller';
import type { PinnedContext } from '../src/context-pins';
import type { SkillRegistry } from '../src/skills';
import type { SmartAideSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/settings';

/**
 * Vitest's node environment has no HTMLElement, but the obsidian mock
 * Component-ish helpers (createDiv/createEl/empty/show/hide/etc) live on
 * extended DOM prototypes that don't exist here. We hand the controller stub
 * objects whose DOM-touching methods are no-ops — the tests assert on
 * controller state, not on rendered output.
 */

function stubEl(extra: Partial<Record<string, unknown>> = {}): any {
	const el: any = {
		style: {},
		dataset: {},
		value: '',
		scrollHeight: 100,
		selectionStart: 0,
		selectionEnd: 0,
		parentElement: null,
		disabled: false,
		empty: () => undefined,
		hide: () => undefined,
		show: () => undefined,
		focus: () => undefined,
		setText: () => undefined,
		setSelectionRange: (s: number, e: number) => {
			el.selectionStart = s;
			el.selectionEnd = e;
		},
		setAttribute: () => undefined,
		addClass: () => undefined,
		removeClass: () => undefined,
		toggleClass: () => undefined,
		createDiv: () => stubEl(),
		createSpan: () => stubEl(),
		createEl: () => stubEl(),
		closest: () => null,
		insertBefore: () => undefined,
		remove: () => undefined,
		querySelector: () => null,
		querySelectorAll: () => [],
		contains: () => false,
		appendChild: () => undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		...extra,
	};
	return el;
}

function makeHost(overrides: Partial<ComposerHost> = {}): ComposerHost {
	return {
		app: new App(),
		settings: DEFAULT_SETTINGS,
		skills: { userInvocableSkills: () => [] } as unknown as SkillRegistry,
		pinned: {
			add: vi.fn(),
			has: () => false,
		} as unknown as PinnedContext,
		saveSettings: async () => undefined,
		refreshContextChips: () => undefined,
		refreshTokenChip: () => undefined,
		rerenderStream: () => undefined,
		isStreaming: () => false,
		activeModelSupportsImages: () => true,
		registerDomEvent: () => undefined,
		...overrides,
	};
}

function makeController(host: ComposerHost = makeHost()): {
	controller: ComposerController;
	composerEl: any;
	attachmentRowEl: any;
	sendBtn: any;
	host: ComposerHost;
} {
	const composerEl = stubEl();
	const attachmentRowEl = stubEl();
	const sendBtn = stubEl();
	return {
		controller: new ComposerController(host, composerEl, attachmentRowEl, sendBtn),
		composerEl,
		attachmentRowEl,
		sendBtn,
		host,
	};
}

// ---------- pending images ----------

describe('ComposerController.pendingImages', () => {
	it('starts empty', () => {
		const { controller } = makeController();
		expect(controller.pendingImages).toEqual([]);
	});

	it('consumePendingImages returns a snapshot and clears the buffer', async () => {
		const { controller, host } = makeController();
		const vault = (host.app as App).vault;
		// Seed pending via attachVaultImage which is the only "no-real-File" path.
		(vault as unknown as { getFileByPath: (p: string) => TFile | null }).getFileByPath = (p) => {
			const f = new TFile();
			f.path = p;
			f.extension = 'png';
			return f;
		};
		await controller.attachVaultImage('a.png');
		await controller.attachVaultImage('b.png');
		expect(controller.pendingImages.length).toBe(2);

		const snapshot = controller.consumePendingImages();
		expect(snapshot.length).toBe(2);
		expect(controller.pendingImages.length).toBe(0);
	});

	it('attachVaultImage rejects unsupported MIME types (HEIC)', async () => {
		const { controller, host } = makeController();
		(host.app.vault as unknown as { getFileByPath: (p: string) => TFile | null }).getFileByPath = (p) => {
			const f = new TFile();
			f.path = p;
			f.extension = 'heic';
			return f;
		};
		await controller.attachVaultImage('photo.heic');
		expect(controller.pendingImages.length).toBe(0);
	});

	it('attachVaultImage on a missing path is a no-op', async () => {
		const { controller, host } = makeController();
		(host.app.vault as unknown as { getFileByPath: () => null }).getFileByPath = () => null;
		await controller.attachVaultImage('nope.png');
		expect(controller.pendingImages.length).toBe(0);
	});
});

// ---------- handleDroppedFiles filtering ----------

describe('ComposerController.handleDroppedFiles filtering', () => {
	function fakeFile(name: string, type: string, content = 'x'): File {
		// Node's File constructor is in the global namespace from undici (Node 18+).
		return new File([content], name, { type });
	}

	it('skips non-image files', async () => {
		const { controller } = makeController();
		const fileList = [fakeFile('notes.txt', 'text/plain')] as unknown as FileList;
		Object.defineProperty(fileList, 'length', { value: 1 });
		await controller.handleDroppedFiles(fileList);
		expect(controller.pendingImages.length).toBe(0);
	});

	it('skips unsupported image MIME types', async () => {
		const { controller } = makeController();
		const fileList = [fakeFile('photo.heic', 'image/heic')] as unknown as FileList;
		Object.defineProperty(fileList, 'length', { value: 1 });
		await controller.handleDroppedFiles(fileList);
		expect(controller.pendingImages.length).toBe(0);
	});
});

// ---------- pin via drag-drop path ----------

describe('ComposerController.tryPinVaultPath', () => {
	it('pins a vault-resident .md path and returns true', () => {
		const pin = vi.fn();
		const host = makeHost({
			pinned: {
				add: pin,
				has: () => false,
			} as unknown as PinnedContext,
		});
		(host.app.vault as unknown as { getFileByPath: (p: string) => TFile | null }).getFileByPath = (
			p,
		) => {
			const f = new TFile();
			f.path = p;
			return f;
		};
		const { controller } = makeController(host);
		expect(controller.tryPinVaultPath('Daily/2026-05-25.md')).toBe(true);
		expect(pin).toHaveBeenCalledWith('Daily/2026-05-25.md');
	});

	it('rejects wikilink syntax', () => {
		const { controller } = makeController();
		expect(controller.tryPinVaultPath('[[Note]]')).toBe(false);
	});

	it('rejects non-vault paths', () => {
		const host = makeHost();
		(host.app.vault as unknown as { getFileByPath: () => null }).getFileByPath = () => null;
		const { controller } = makeController(host);
		expect(controller.tryPinVaultPath('random.md')).toBe(false);
	});
});

// ---------- edit-fork lifecycle ----------

describe('ComposerController edit-fork', () => {
	it('startEditBranch sets dataset markers + editingFromId, calls rerenderStream', () => {
		const rerender = vi.fn();
		const { controller, composerEl } = makeController(makeHost({ rerenderStream: rerender }));
		const parent = {
			id: 'entry-1',
			parentId: 'root',
			type: 'message' as const,
			timestamp: '2026-05-25T00:00:00Z',
			message: { role: 'user' as const, content: 'previous text' },
		};
		controller.startEditBranch(parent);
		expect(composerEl.dataset.branchFrom).toBe('entry-1');
		expect(composerEl.dataset.branchParent).toBe('root');
		expect(controller.editingFromId).toBe('entry-1');
		expect(controller.branchFrom).toBe('entry-1');
		expect(controller.branchParent).toBe('root');
		expect(rerender).toHaveBeenCalled();
	});

	it('finishEditBranch clears dataset + editing flag without rerendering', () => {
		const rerender = vi.fn();
		const { controller, composerEl } = makeController(makeHost({ rerenderStream: rerender }));
		controller.startEditBranch({
			id: 'e2',
			parentId: null,
			type: 'message',
			timestamp: '',
			message: { role: 'user', content: 'x' },
		});
		rerender.mockClear();
		controller.finishEditBranch();
		expect(controller.editingFromId).toBe(null);
		expect(composerEl.dataset.branchFrom).toBeUndefined();
		expect(composerEl.dataset.branchParent).toBeUndefined();
		// finishEditBranch is the post-send cleanup — send already rerenders.
		expect(rerender).not.toHaveBeenCalled();
	});

	it('cancelEdit clears the edit state and triggers a rerender', () => {
		const rerender = vi.fn();
		const { controller } = makeController(makeHost({ rerenderStream: rerender }));
		controller.startEditBranch({
			id: 'e3',
			parentId: null,
			type: 'message',
			timestamp: '',
			message: { role: 'user', content: 'x' },
		});
		rerender.mockClear();
		controller.cancelEdit();
		expect(controller.editingFromId).toBe(null);
		expect(rerender).toHaveBeenCalled();
	});
});

// ---------- slash autocomplete ----------

describe('ComposerController.updateSlashPopover', () => {
	(globalThis as any).window = (globalThis as any).window ?? { setTimeout: (fn: () => void) => setTimeout(fn, 0) };
	(globalThis as any).document = (globalThis as any).document ?? { addEventListener: () => undefined, removeEventListener: () => undefined };

	function makeSlashHost(skills: Array<{ name: string; description: string; userInvocable: boolean; mobile: boolean }>): ComposerHost {
		return makeHost({
			skills: {
				userInvocableSkills: () => skills.filter((s) => s.userInvocable),
			} as unknown as SkillRegistry,
		});
	}

	function makeSlashController(host: ComposerHost) {
		const composerWrap = stubEl();
		const composerEl = stubEl({ closest: () => composerWrap });
		const attachmentRowEl = stubEl();
		const sendBtn = stubEl();
		const controller = new ComposerController(host, composerEl, attachmentRowEl, sendBtn);
		return { controller, composerEl, composerWrap };
	}

	it('opens the popover when value matches /<query> and a user-invocable skill matches', () => {
		const host = makeSlashHost([
			{ name: 'moc-builder', description: 'Build a MOC', userInvocable: true, mobile: true },
			{ name: 'daily-note', description: 'Daily note', userInvocable: true, mobile: true },
		]);
		const { controller, composerEl } = makeSlashController(host);
		composerEl.value = '/mo';
		controller.updateSlashPopover();
		expect(controller.isSlashOpen()).toBe(true);
	});

	it('keeps the popover closed when there are no user-invocable skills', () => {
		const host = makeSlashHost([
			{ name: 'moc-builder', description: 'Build a MOC', userInvocable: false, mobile: true },
		]);
		const { controller, composerEl } = makeSlashController(host);
		composerEl.value = '/mo';
		controller.updateSlashPopover();
		expect(controller.isSlashOpen()).toBe(false);
	});

	it('keeps the popover closed when value has trailing space (slash settled)', () => {
		const host = makeSlashHost([
			{ name: 'moc-builder', description: 'Build a MOC', userInvocable: true, mobile: true },
		]);
		const { controller, composerEl } = makeSlashController(host);
		composerEl.value = '/mo ';
		controller.updateSlashPopover();
		expect(controller.isSlashOpen()).toBe(false);
	});
});
