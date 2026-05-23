import { beforeEach, describe, expect, it } from 'vitest';
import { App, TFile, Vault } from 'obsidian';
import { AgentsMdRegistry } from '../src/agents-md';

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

describe('AgentsMdRegistry', () => {
	let vault: MiniVault;
	let app: App;

	beforeEach(() => {
		vault = new MiniVault();
		app = new App();
		app.vault = vault as unknown as Vault;
	});

	it('returns "" when AGENTS.md is absent', async () => {
		const reg = new AgentsMdRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('');
	});

	it('reads and trims AGENTS.md when present', async () => {
		vault.addFile('Meta/AGENTS.md', '\n\n# Vault\n\nLayout: stuff\n\n');
		const reg = new AgentsMdRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('# Vault\n\nLayout: stuff');
	});

	it('switches to a different metaDir via setDir', async () => {
		vault.addFile('sys/AGENTS.md', 'sys body');
		const reg = new AgentsMdRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('');
		reg.setDir('sys');
		await reg.load();
		expect(reg.text()).toBe('sys body');
	});

	it('clears the body when the file disappears between loads', async () => {
		vault.addFile('Meta/AGENTS.md', 'hi');
		const reg = new AgentsMdRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('hi');
		vault.files.delete('Meta/AGENTS.md');
		await reg.load();
		expect(reg.text()).toBe('');
	});

	it('reads vault-root AGENTS.md when metaDir file is absent', async () => {
		vault.addFile('AGENTS.md', 'root body');
		const reg = new AgentsMdRegistry(app, 'Meta');
		await reg.load();
		expect(reg.text()).toBe('root body');
	});

	it('concatenates root and metaDir AGENTS.md with headers, root first', async () => {
		vault.addFile('AGENTS.md', 'root body');
		vault.addFile('sys/AGENTS.md', 'sys body');
		const reg = new AgentsMdRegistry(app, 'sys');
		await reg.load();
		expect(reg.text()).toBe('# AGENTS.md\n\nroot body\n\n---\n\n# sys/AGENTS.md\n\nsys body');
	});

	it('reads the root file once when metaDir resolves to vault root', async () => {
		vault.addFile('AGENTS.md', 'root body');
		const reg = new AgentsMdRegistry(app, '.');
		await reg.load();
		expect(reg.text()).toBe('root body');
	});
});
