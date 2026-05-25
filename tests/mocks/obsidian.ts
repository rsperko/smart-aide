/**
 * Test-only stub of the `obsidian` module. vitest.config.ts aliases `obsidian`
 * to this file so any src/* file can be imported in tests.
 *
 * We only implement what the source needs to evaluate. Behavior-bearing
 * helpers (normalizePath, prepareSimpleSearch, prepareFuzzySearch, getAllTags) get real-ish
 * implementations so unit tests can call into them. DOM/UI classes are inert
 * stubs — tests that touch them are out of scope for the 50% tier.
 */

// ---------- Path / search primitives ----------

/**
 * Mirror Obsidian's normalizePath shape: convert backslashes, collapse
 * repeated slashes, strip trailing slash, return '/' for empty / root.
 */
export function normalizePath(input: string): string {
	if (input == null) return '/';
	let p = String(input).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
	return p || '/';
}

/**
 * Mirror Obsidian's prepareSimpleSearch: tokenize the query on whitespace, then
 * require every token to appear in the text as a case-insensitive substring.
 * Score is the negated position of the earliest token match (earlier = higher).
 */
export function prepareSimpleSearch(query: string): (text: string) => { score: number; matches: number[][] } | null {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return (text: string) => {
		if (tokens.length === 0) return null;
		const lower = text.toLowerCase();
		const matches: number[][] = [];
		let firstIdx = Infinity;
		for (const t of tokens) {
			const idx = lower.indexOf(t);
			if (idx < 0) return null;
			matches.push([idx, idx + t.length]);
			if (idx < firstIdx) firstIdx = idx;
		}
		return { score: -firstIdx, matches };
	};
}

/**
 * Mirror Obsidian's prepareFuzzySearch: character-order scatter match. Every
 * non-whitespace char of the query must appear in the text in order, with any
 * gaps allowed between them. Catches typos and abbreviations.
 */
export function prepareFuzzySearch(query: string): (text: string) => { score: number; matches: number[][] } | null {
	const chars = query.toLowerCase().replace(/\s+/g, '');
	return (text: string) => {
		if (chars.length === 0) return null;
		const lower = text.toLowerCase();
		const positions: number[] = [];
		let cursor = 0;
		for (const c of chars) {
			const idx = lower.indexOf(c, cursor);
			if (idx < 0) return null;
			positions.push(idx);
			cursor = idx + 1;
		}
		// Score: higher when the matches are tighter and start earlier.
		const span = positions[positions.length - 1] - positions[0];
		return { score: -(positions[0] + span), matches: positions.map((p) => [p, p + 1]) };
	};
}

/**
 * Pull tags out of a metadata cache: inline `cache.tags[*].tag` plus
 * frontmatter `cache.frontmatter.tags` (array or comma/space-separated string).
 */
export function getAllTags(cache: { tags?: { tag: string }[]; frontmatter?: Record<string, unknown> } | null | undefined): string[] | null {
	if (!cache) return null;
	const out = new Set<string>();
	for (const t of cache.tags ?? []) out.add(t.tag);
	const fm = cache.frontmatter?.tags;
	if (Array.isArray(fm)) for (const t of fm) out.add('#' + String(t));
	else if (typeof fm === 'string') for (const t of fm.split(/[,\s]+/)) if (t) out.add('#' + t);
	return Array.from(out);
}

export function parseLinktext(href: string): { path: string; subpath: string } {
	const hashIdx = href.indexOf('#');
	if (hashIdx < 0) return { path: href, subpath: '' };
	return { path: href.slice(0, hashIdx), subpath: href.slice(hashIdx) };
}

/**
 * Mirror Obsidian's parseFrontMatterAliases: accepts the frontmatter object,
 * returns a string[] from the `aliases` (or legacy `alias`) field. Handles
 * arrays, comma-separated strings, and YAML inline-array strings. Returns null
 * when no aliases are present.
 */
export function parseFrontMatterAliases(frontmatter: Record<string, unknown> | null | undefined): string[] | null {
	if (!frontmatter) return null;
	const raw = (frontmatter.aliases ?? frontmatter.alias) as unknown;
	if (raw == null) return null;
	if (Array.isArray(raw)) {
		const out = raw.map((v) => String(v).trim()).filter(Boolean);
		return out.length > 0 ? out : null;
	}
	if (typeof raw === 'string') {
		const stripped = raw.trim().replace(/^\[|\]$/g, '');
		const parts = stripped.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
		return parts.length > 0 ? parts : null;
	}
	return null;
}

// ---------- Platform ----------

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isMobileApp: false,
	isDesktopApp: true,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
};

// ---------- Vault primitives ----------

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = '';
	extension = '';
	stat: { mtime: number; ctime: number; size: number } = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export class Vault {
	getFileByPath(_path: string): TFile | null {
		return null;
	}
	getAbstractFileByPath(_path: string): TAbstractFile | null {
		return null;
	}
	getMarkdownFiles(): TFile[] {
		return [];
	}
	getName(): string {
		return 'test-vault';
	}
	async cachedRead(_file: TFile): Promise<string> {
		return '';
	}
	async read(_file: TFile): Promise<string> {
		return '';
	}
	async create(_path: string, _content: string): Promise<TFile> {
		return new TFile();
	}
	async createBinary(_path: string, _data: ArrayBuffer): Promise<TFile> {
		return new TFile();
	}
	async readBinary(_file: TFile): Promise<ArrayBuffer> {
		return new ArrayBuffer(0);
	}
	getResourcePath(file: TFile): string {
		return `app://local/${file.path}`;
	}
	async createFolder(_path: string): Promise<TFolder> {
		return new TFolder();
	}
	async append(_file: TFile, _content: string): Promise<void> {}
	async process(_file: TFile, _fn: (content: string) => string): Promise<void> {}
	async delete(_file: TAbstractFile): Promise<void> {}
	adapter = {
		exists: async (_p: string) => false,
	};
}

export class App {
	vault = new Vault();
	metadataCache = {
		resolvedLinks: {} as Record<string, Record<string, number>>,
		getFileCache: (_file: TFile) => null,
		getFirstLinkpathDest: (_link: string, _src: string) => null,
	};
	workspace = {
		rootSplit: null,
		getActiveFile: () => null,
		getLeavesOfType: (_t: string) => [],
		getRightLeaf: (_create: boolean) => null,
		getLeaf: (_create: unknown) => null,
		getMostRecentLeaf: (_root?: unknown) => null,
		setActiveLeaf: (_l: unknown, _o?: unknown) => undefined,
		iterateRootLeaves: (_fn: (l: unknown) => void) => undefined,
		onLayoutReady: (_fn: () => void) => undefined,
		on: (_e: string, _fn: () => void) => ({}),
		offref: (_r: unknown) => undefined,
		revealLeaf: (_l: unknown) => undefined,
		trigger: (_e: string) => undefined,
	};
	fileManager = {
		trashFile: async (_f: TFile) => undefined,
		getAvailablePathForAttachment: async (filename: string) => `attachments/${filename}`,
	};
}

// ---------- UI / Component stubs (no behavior, exist so src files evaluate) ----------

export class Notice {
	constructor(_msg: string, _timeout?: number) {}
	setMessage(_m: string): this {
		return this;
	}
	hide(): void {}
}

export class Component {
	addChild<T extends Component>(c: T): T {
		return c;
	}
	removeChild<T extends Component>(c: T): T {
		return c;
	}
	register(_cb: () => void): void {}
	registerEvent(_ref: unknown): void {}
	registerDomEvent(_el: unknown, _type: string, _cb: unknown): void {}
	load(): void {}
	unload(): void {}
}

export class MarkdownRenderChild extends Component {
	containerEl: HTMLElement | null = null;
	constructor(el?: HTMLElement) {
		super();
		this.containerEl = el ?? null;
	}
}

export const MarkdownRenderer = {
	async render(_app: App, _md: string, _el: unknown, _src: string, _comp: Component): Promise<void> {},
};

export class ItemView extends Component {
	containerEl: { children: unknown[] } = { children: [] };
	leaf: WorkspaceLeaf;
	app = new App();
	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
	}
	getViewType(): string {
		return '';
	}
	getDisplayText(): string {
		return '';
	}
	getIcon(): string {
		return '';
	}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

export class WorkspaceLeaf {
	view: unknown = null;
	async openFile(_f: TFile, _state?: unknown): Promise<void> {}
	async setViewState(_state: unknown): Promise<void> {}
	detach(): void {}
}

export class Plugin extends Component {
	app = new App();
	settings: unknown;
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {}
	addRibbonIcon(_icon: string, _title: string, _cb: () => void): unknown {
		return {};
	}
	addCommand(_cmd: unknown): unknown {
		return {};
	}
	addSettingTab(_tab: unknown): void {}
	registerView(_type: string, _factory: (l: WorkspaceLeaf) => ItemView): void {}
	async onload(): Promise<void> {}
	async onunload(): Promise<void> {}
}

export class PluginSettingTab {
	containerEl: HTMLElement = makeStubEl();
	app: App;
	plugin: Plugin;
	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}
	display(): void {}
	hide(): void {}
}

export class Modal {
	app: App;
	contentEl: HTMLElement = makeStubEl();
	titleEl: HTMLElement = makeStubEl();
	constructor(app: App) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
	setTitle(_t: string): this {
		return this;
	}
}

export class FuzzySuggestModal<T> extends Modal {
	constructor(app: App) {
		super(app);
	}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return '';
	}
	onChooseItem(_item: T, _evt?: unknown): void {}
	setPlaceholder(_p: string): void {}
}

export interface FuzzyMatch<T> {
	item: T;
	match: { score: number; matches: number[][] };
}

export class Setting {
	settingEl: HTMLElement = makeStubEl();
	controlEl: HTMLElement = makeStubEl();
	constructor(_container: unknown) {}
	setName(_n: string): this { return this; }
	setDesc(_d: string): this { return this; }
	setHeading(): this { return this; }
	setClass(_c: string): this { return this; }
	addText(_cb: (t: TextStub) => void): this { _cb(new TextStub()); return this; }
	addTextArea(_cb: (t: TextStub) => void): this { _cb(new TextStub()); return this; }
	addToggle(_cb: (t: ToggleStub) => void): this { _cb(new ToggleStub()); return this; }
	addButton(_cb: (b: ButtonStub) => void): this { _cb(new ButtonStub()); return this; }
	addExtraButton(_cb: (b: ButtonStub) => void): this { _cb(new ButtonStub()); return this; }
	addDropdown(_cb: (d: DropdownStub) => void): this { _cb(new DropdownStub()); return this; }
}

class TextStub {
	setPlaceholder(_p: string): this { return this; }
	setValue(_v: string): this { return this; }
	onChange(_cb: (v: string) => unknown): this { return this; }
}
class ToggleStub {
	setValue(_v: boolean): this { return this; }
	onChange(_cb: (v: boolean) => unknown): this { return this; }
}
class ButtonStub {
	setButtonText(_t: string): this { return this; }
	setIcon(_i: string): this { return this; }
	setTooltip(_t: string): this { return this; }
	setCta(): this { return this; }
	onClick(_cb: () => unknown): this { return this; }
}
class DropdownStub {
	addOption(_v: string, _l: string): this { return this; }
	setValue(_v: string): this { return this; }
	onChange(_cb: (v: string) => unknown): this { return this; }
}

export class ButtonComponent {
	buttonEl: HTMLElement = makeStubEl();
	constructor(_container: unknown) {}
	setButtonText(_t: string): this { return this; }
	setIcon(_i: string): this { return this; }
	setTooltip(_t: string): this { return this; }
	setCta(): this { return this; }
	setWarning(): this { return this; }
	onClick(_cb: () => unknown): this { return this; }
}

export function setIcon(_el: unknown, _icon: string): void {}

export function requestUrl(_opts: unknown): Promise<{ status: number; text: string; json: unknown; arrayBuffer: ArrayBuffer }> {
	return Promise.resolve({ status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0) });
}

// ---------- DOM stub helper ----------

function makeStubEl(): HTMLElement {
	// Tests for src/* that touch DOM are out of scope; this is just enough to
	// keep evaluation happy. Tests that want real DOM should set the vitest
	// environment to jsdom in the per-file config block.
	const noop = () => {};
	const stub: Record<string, unknown> = {
		empty: noop,
		createDiv: () => makeStubEl(),
		createEl: () => makeStubEl(),
		createSpan: () => makeStubEl(),
		setText: noop,
		getText: () => '',
		addClass: noop,
		removeClass: noop,
		toggleClass: noop,
		setAttribute: noop,
		appendChild: noop,
		insertBefore: noop,
		remove: noop,
		hide: noop,
		show: noop,
		addEventListener: noop,
		removeEventListener: noop,
		querySelector: () => null,
		querySelectorAll: () => [],
		title: '',
		style: {} as CSSStyleDeclaration,
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
		children: [],
		parentElement: null,
		dataset: {},
	};
	return stub as unknown as HTMLElement;
}
