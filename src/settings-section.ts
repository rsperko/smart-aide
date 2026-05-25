import type { App } from 'obsidian';
import type SmartAidePlugin from './main';

export type SectionId =
	| 'overview'
	| 'providers'
	| 'chatModels'
	| 'vaultData'
	| 'skills'
	| 'safety'
	| 'advanced';

export interface SectionContext {
	app: App;
	plugin: SmartAidePlugin;
	redisplay: () => void;
	enterEndpointEditor: (id: string) => void;
	scrollToSection: (id: SectionId) => void;
	/** Monotonic render counter; sections compare a captured value against the
	 * current to discard background work from a stale display() pass. */
	currentRenderGen: () => number;
}
