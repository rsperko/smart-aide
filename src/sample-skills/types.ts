import type { Vault } from 'obsidian';
import { normalizePath } from 'obsidian';

export interface SampleSkill {
	/** Filename slug (also the frontmatter `name`). */
	name: string;
	/** One-line description shown in the settings UI. */
	shortDescription: string;
	/** Suggested model for this skill — UI hint only, not in the SKILL.md body. */
	recommendedModel: string;
	/** Full SKILL.md content including frontmatter. */
	body: string;
}

export type SampleInstallState = 'not-installed' | 'installed-current' | 'installed-modified';

export interface SampleInstallStatus {
	state: SampleInstallState;
	path: string;
}

/**
 * Check whether a sample skill is already installed and whether the on-disk
 * copy still matches the bundled body byte-for-byte. Drives the per-row state
 * machine in the settings UI: Install / Installed / Re-install.
 */
export async function readSampleStatus(
	vault: Vault,
	skillsDir: string,
	skill: SampleSkill,
): Promise<SampleInstallStatus> {
	const path = normalizePath(`${skillsDir}/${skill.name}.md`);
	const file = vault.getFileByPath(path);
	if (!file) return { state: 'not-installed', path };
	const content = await vault.cachedRead(file);
	return {
		state: content === skill.body ? 'installed-current' : 'installed-modified',
		path,
	};
}

export type InstallResult =
	| { status: 'created'; path: string }
	| { status: 'unchanged'; path: string }
	| { status: 'skipped-modified'; path: string }
	| { status: 'overwritten'; path: string; backupPath: string };

/**
 * Install a sample skill to {skillsDir}/{name}.md.
 *
 * - File missing → create.
 * - File present and bytes match → no-op.
 * - File present but bytes differ → require opts.overwrite. When overwriting,
 *   first save the existing content to a {name}.md.bak sibling so the user's
 *   customizations are recoverable.
 */
export async function installSample(
	vault: Vault,
	skillsDir: string,
	skill: SampleSkill,
	opts: { overwrite?: boolean } = {},
): Promise<InstallResult> {
	const path = normalizePath(`${skillsDir}/${skill.name}.md`);
	const file = vault.getFileByPath(path);

	if (!file) {
		if (!(await vault.adapter.exists(skillsDir))) {
			await vault.createFolder(skillsDir);
		}
		await vault.create(path, skill.body);
		return { status: 'created', path };
	}

	const existing = await vault.cachedRead(file);
	if (existing === skill.body) return { status: 'unchanged', path };
	if (!opts.overwrite) return { status: 'skipped-modified', path };

	const backupPath = normalizePath(`${path}.bak`);
	const existingBackup = vault.getFileByPath(backupPath);
	if (existingBackup) {
		await vault.modify(existingBackup, existing);
	} else {
		await vault.create(backupPath, existing);
	}
	await vault.modify(file, skill.body);
	return { status: 'overwritten', path, backupPath };
}
