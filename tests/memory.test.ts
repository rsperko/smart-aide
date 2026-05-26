import { beforeEach, describe, expect, it } from 'vitest';
import { App, TFile, Vault } from 'obsidian';
import { MemoryRegistry } from '../src/memory';

class MiniVault extends Vault {
	files = new Map<string, string>();

	getAbstractFileByPath(path: string): TFile | null {
		if (!this.files.has(path)) return null;
		const f = new TFile();
		f.path = path;
		f.extension = 'md';
		return f;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? '';
	}

	addFile(path: string, content: string): void {
		this.files.set(path, content);
	}
}

describe('MemoryRegistry', () => {
	let vault: MiniVault;
	let app: App;

	beforeEach(() => {
		vault = new MiniVault();
		app = new App();
		app.vault = vault as unknown as Vault;
	});

	it('returns "" when memory.md is absent', async () => {
		const reg = new MemoryRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('');
	});

	it('reads memory.md from the branded Smart Aide subfolder, not the metaDir root', async () => {
		// memory.md at metaDir root should be ignored — the registry only looks
		// under `${metaDir}/Smart Aide/memory.md`.
		vault.addFile('Meta/memory.md', 'wrong location');
		vault.addFile('Meta/Smart Aide/memory.md', 'right location');
		const reg = new MemoryRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('right location');
	});

	it('trims surrounding whitespace from the loaded body', async () => {
		vault.addFile('Meta/Smart Aide/memory.md', '\n\n## Preferences\n\n- 2026-05-26: foo\n\n');
		const reg = new MemoryRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('## Preferences\n\n- 2026-05-26: foo');
	});

	it('switches to a different metaDir via setDir', async () => {
		vault.addFile('sys/Smart Aide/memory.md', 'sys body');
		const reg = new MemoryRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('');
		reg.setDir('sys');
		await reg.load();
		expect(reg.text()).toBe('sys body');
	});

	it('clears the body when the file disappears between loads', async () => {
		vault.addFile('Meta/Smart Aide/memory.md', 'hi');
		const reg = new MemoryRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('hi');
		vault.files.delete('Meta/Smart Aide/memory.md');
		await reg.load();
		expect(reg.text()).toBe('');
	});

	it('exposes the canonical path for the UI to open', async () => {
		const reg = new MemoryRegistry(app, 'Meta');
		expect(reg.path()).toBe('Meta/Smart Aide/memory.md');
		reg.setDir('sys');
		expect(reg.path()).toBe('sys/Smart Aide/memory.md');
	});
});
