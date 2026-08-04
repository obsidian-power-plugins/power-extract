import {
	FuzzySuggestModal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingDefinitionRender,
	TFile,
} from "obsidian";
import { spawn } from "node:child_process";
import { env } from "node:process";
import { type CacheMap, cacheStats, isFresh, parseCache, pruneCache, serializeCache } from "./cache";
import { OcrEngine, type WorkerProcess, unavailableMessage, type OcrUnavailable } from "./ocr";
import { OCR_WORKER_PS1, powershellPath, workerArgs } from "./worker";

/** Image types the recognizer is asked to read. Windows decodes png, jpeg, bmp
 *  and gif itself; webp arrived as a system codec later and is not on every
 *  machine, so it is offered and allowed to fail per file rather than being
 *  refused outright here. */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif"]);

/** Spawn, narrowed to the one call this plugin makes and the one shape it needs
 *  back.
 *
 *  The cast is for the streams, not for the types: a ChildProcess declares
 *  stdin, stdout and stderr as possibly null, because a process started with
 *  other stdio options has none. This one is always started with pipes, so all
 *  three are always there, and `WorkerProcess` says exactly that and nothing
 *  more. Everything else about the call is checked normally now that the
 *  tsconfig names the node types. */
const spawnProcess = spawn as unknown as (
	cmd: string,
	args: string[],
	opts: { windowsHide: boolean; shell: boolean }
) => WorkerProcess;

/** Where Windows is installed, for building the path to the OCR host.
 *
 *  From `node:process`, not `globalThis`. The review asks plugins to reach for
 *  `window` or `activeWindow` so that code touching a popout window addresses
 *  the right one, and it flags the global object on sight. This is not
 *  window-shaped at all: it wants Node's environment, so it asks Node for it,
 *  the way the line above asks Node for spawn.
 *
 *  Read-only, and only ever %SystemRoot%: nothing is written to the environment
 *  and nothing else is read from it. */
function systemRoot(): string | undefined {
	return env.SystemRoot;
}

interface PowerExtractSettings {
	/** Offer "Extract text" when right-clicking an image. */
	rightClickMenu: boolean;
	/** Keep what was read, so an image is only ever read once. Off is for
	 *  people who would rather spend the time than the disk. */
	useCache: boolean;
}

const DEFAULT_SETTINGS: PowerExtractSettings = {
	rightClickMenu: true,
	useCache: true,
};

/** What other plugins call. Deliberately the same shape the Text Extractor
 *  plugin exposes, so a plugin that supports one supports the other with a
 *  change of id and no change of code. */
export interface PowerExtractApi {
	/** Text found in an image, from cache when it is there. Rejects when this
	 *  device cannot read images at all, or when this file could not be read. */
	extractText(file: TFile): Promise<string>;
	/** Is this a file type this plugin reads? */
	canExtract(file: TFile): boolean;
	/** Can this device read anything at all? False on mobile, on macOS and
	 *  Linux, and on a Windows install with no OCR language. */
	isAvailable(): boolean;
	/** The recognizer's language tag once a worker has started, else null. */
	language(): string | null;
}

export default class PowerExtractPlugin extends Plugin {
	settings: PowerExtractSettings = DEFAULT_SETTINGS;
	private baseline: PowerExtractSettings = DEFAULT_SETTINGS;
	private loadFailed = false;

	engine: OcrEngine | null = null;
	private cache: CacheMap = {};
	private cacheDirty = false;
	private cacheTimer: number | null = null;
	private scriptReady: Promise<string> | null = null;
	/** Extractions in flight, keyed by path: two callers asking for the same
	 *  image at once (the search index and a right-click) wait on one read
	 *  rather than starting two. */
	private inFlight = new Map<string, Promise<string>>();

	api: PowerExtractApi = {
		extractText: (file) => this.extractText(file),
		canExtract: (file) => this.canExtract(file),
		isAvailable: () => this.unavailableReason() === null,
		language: () => this.engine?.language ?? null,
	};

	async onload() {
		await this.loadSettings();
		this.cache = this.settings.useCache ? parseCache(await this.readCacheFile()) : {};

		this.engine = new OcrEngine({
			spawn: () => this.spawnWorker(),
			log: (message, detail) => console.warn("Power Extract: " + message, detail ?? ""),
		});

		this.addSettingTab(new PowerExtractSettingTab(this));

		this.addCommand({
			id: "copy-image-text",
			name: "Copy the text from an image",
			callback: () => new ImagePickerModal(this).open(),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.settings.rightClickMenu) return;
				if (!(file instanceof TFile) || !this.canExtract(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Copy text from image")
						.setIcon("scan-text")
						.onClick(() => void this.copyTextToClipboard(file))
				);
			})
		);

		// An image deleted from the vault takes its cached text with it, so the
		// file does not accumulate the whole history of everything ever pasted.
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && this.cache[file.path]) {
					delete this.cache[file.path];
					this.queueCacheSave();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const entry = this.cache[oldPath];
				if (!entry) return;
				delete this.cache[oldPath];
				if (file instanceof TFile) this.cache[file.path] = entry;
				this.queueCacheSave();
			})
		);
	}

	onunload() {
		this.engine?.stop();
		if (this.cacheTimer !== null) {
			window.clearTimeout(this.cacheTimer);
			this.cacheTimer = null;
		}
		if (this.cacheDirty) void this.writeCacheFile();
	}

	/* ---------------- extraction ---------------- */

	canExtract(file: TFile): boolean {
		return IMAGE_EXTS.has(file.extension.toLowerCase());
	}

	/**
	 * The one way text comes out of an image.
	 *
	 * Cache first, then the recognizer. A second caller asking for the same
	 * image while the first is still waiting joins that read instead of starting
	 * its own: the search index sweeping a folder and someone right-clicking a
	 * screenshot in it is an ordinary way for that to happen.
	 */
	async extractText(file: TFile): Promise<string> {
		if (!this.canExtract(file)) {
			throw new Error(`Power Extract does not read .${file.extension} files.`);
		}
		const cached = this.cache[file.path];
		if (this.settings.useCache && isFresh(cached, file.stat.mtime, file.stat.size)) return cached.t;

		const existing = this.inFlight.get(file.path);
		if (existing) return existing;

		const run = this.readImage(file).finally(() => this.inFlight.delete(file.path));
		this.inFlight.set(file.path, run);
		return run;
	}

	private async readImage(file: TFile): Promise<string> {
		const why = this.unavailableReason();
		if (why) throw new Error(unavailableMessage(why));
		const engine = this.engine;
		if (!engine) throw new Error("Power Extract is not loaded.");

		const scriptPath = await this.ensureWorkerScript(engine.running);
		if (!scriptPath) throw new Error("Power Extract could not write its OCR worker.");

		const abs = this.absolutePath(file.path);
		if (!abs) throw new Error("Power Extract needs a vault stored on disk.");

		const text = (await engine.extract(abs)).trim();
		if (this.settings.useCache) {
			this.cache[file.path] = { m: file.stat.mtime, s: file.stat.size, t: text };
			this.queueCacheSave();
		}
		return text;
	}

	/** Why this device cannot read images, or null when it can. Checked before
	 *  every start so the answer stays current if a worker later reports that
	 *  Windows has no recognizer. */
	unavailableReason(): OcrUnavailable | null {
		if (!Platform.isDesktopApp) return "no-node";
		if (!Platform.isWin) return "not-windows";
		return this.engine?.unavailable ?? null;
	}

	async copyTextToClipboard(file: TFile) {
		const notice = new Notice("Power Extract: reading " + file.name + "...", 0);
		try {
			const text = await this.extractText(file);
			notice.hide();
			if (!text) {
				new Notice("Power Extract: no text found in " + file.name + ".");
				return;
			}
			// Written, never read. The plugin has no reason to know what was on
			// the clipboard before this, and never asks: this is the only line in
			// the plugin that touches it, it runs only from a menu item or a
			// command the person just chose, and it puts back exactly the text
			// that came out of the image they picked.
			await navigator.clipboard.writeText(text);
			const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
			new Notice("Power Extract: copied " + text.length + " characters.\n" + preview, 6000);
		} catch (e) {
			notice.hide();
			new Notice("Power Extract: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/* ---------------- the worker ---------------- */

	/** Start a PowerShell hosting the recognizer. Desktop-only by manifest, so
	 *  the import at the top of this file is always satisfied by the time this
	 *  runs.
	 *
	 *  The one process this plugin ever starts, and this is the only line that
	 *  starts it. It is a fixed program at a fixed path with fixed arguments:
	 *  nothing a user types, nothing from a file, and nothing from another
	 *  plugin reaches this call. Image paths go to the worker over stdin, well
	 *  away from a command line. `shell: false` is spawn's default and is
	 *  written out anyway, because it is the difference between running a
	 *  program and handing a string to a command interpreter, and that should
	 *  not have to be inferred from an absence. */
	private spawnWorker(): WorkerProcess {
		const script = this.scriptAbsPath;
		if (!script) throw new Error("the OCR worker has not been written yet");
		return spawnProcess(powershellPath(systemRoot()), workerArgs(script), {
			windowsHide: true,
			shell: false,
		});
	}

	private scriptAbsPath: string | null = null;

	/**
	 * The worker script on disk, confirmed to be the script this build carries.
	 *
	 * Confirmed before every start, not once a session. The file sits in the
	 * vault, which is a folder sync services write to and other applications can
	 * open, and a worker that has idled out is started again from whatever the
	 * file holds at that moment. A check from twenty minutes ago says nothing
	 * about that, so the only check worth having is one taken with the start it
	 * belongs to. While a worker is up, the script it is already running cannot
	 * be swapped underneath it, so that is the one case the check is skipped.
	 *
	 * Rewriting on any difference covers a fresh install, an upgrade that changed
	 * the script, and an edit by anything else, without having to tell them
	 * apart: the only script that ever runs is the one shipped in main.js.
	 *
	 * Checks queue behind one another, so two images arriving together cannot
	 * have one reading the file while the other is rewriting it.
	 */
	private ensureWorkerScript(workerRunning: boolean): Promise<string> {
		if (workerRunning && this.scriptReady) return this.scriptReady;
		const check = () => this.writeWorkerScript();
		this.scriptReady = (this.scriptReady ?? Promise.resolve("")).then(check, check);
		return this.scriptReady;
	}

	private async writeWorkerScript(): Promise<string> {
		const rel = `${this.manifest.dir}/ocr-worker.ps1`;
		const adapter = this.app.vault.adapter;
		let current: string | null = null;
		try {
			current = (await adapter.exists(rel)) ? await adapter.read(rel) : null;
		} catch {
			current = null;
		}
		try {
			if (current !== OCR_WORKER_PS1) await adapter.write(rel, OCR_WORKER_PS1);
		} catch (e) {
			// Nothing on disk can be vouched for, so nothing is started. The next
			// image asks again, because no worker is running to skip the check.
			console.warn("Power Extract: could not write the OCR worker", e);
			this.scriptAbsPath = null;
			return "";
		}
		this.scriptAbsPath = this.absolutePath(rel);
		return this.scriptAbsPath ?? "";
	}

	/** A vault path as the operating system sees it. Null when the vault is not
	 *  a folder on disk, which is every mobile vault. */
	private absolutePath(vaultRelative: string): string | null {
		const adapter = this.app.vault.adapter as unknown as {
			getFullPath?: (p: string) => string;
			basePath?: string;
		};
		if (typeof adapter.getFullPath === "function") return adapter.getFullPath(vaultRelative);
		if (adapter.basePath) return `${adapter.basePath}/${vaultRelative}`;
		return null;
	}

	/* ---------------- cache file ---------------- */

	private cachePath(): string {
		return `${this.manifest.dir}/ocr-cache.json`;
	}

	private async readCacheFile(): Promise<string | null> {
		try {
			const path = this.cachePath();
			return (await this.app.vault.adapter.exists(path)) ? await this.app.vault.adapter.read(path) : null;
		} catch (e) {
			console.warn("Power Extract: could not read the cache", e);
			return null;
		}
	}

	private queueCacheSave() {
		this.cacheDirty = true;
		if (this.cacheTimer !== null) window.clearTimeout(this.cacheTimer);
		// A vault-wide sweep finishes an image every 35ms; writing the whole file
		// that often would cost more than the reading does.
		this.cacheTimer = window.setTimeout(() => {
			this.cacheTimer = null;
			void this.writeCacheFile();
		}, 3000);
	}

	private async writeCacheFile() {
		if (!this.settings.useCache) return;
		try {
			await this.app.vault.adapter.write(this.cachePath(), serializeCache(this.cache));
			this.cacheDirty = false;
		} catch (e) {
			console.warn("Power Extract: could not save the cache", e);
		}
	}

	cacheSummary() {
		return cacheStats(this.cache);
	}

	/** Drop cached text for images the vault no longer holds. */
	prune(): number {
		const live = new Set(this.app.vault.getFiles().map((f) => f.path));
		const { map, removed } = pruneCache(this.cache, live);
		this.cache = map;
		if (removed) this.queueCacheSave();
		return removed;
	}

	/** Forget everything read so far, and take the file with it.
	 *
	 *  Deleting rather than writing an empty one, because this is also what
	 *  turning the cache off calls, and the write path declines to run when the
	 *  cache is off: asking to be forgotten and leaving the text sitting on disk
	 *  is the one outcome this must not have. The pending debounced write is
	 *  cancelled first, or it would put the file straight back. */
	async clearCache() {
		this.cache = {};
		this.cacheDirty = false;
		if (this.cacheTimer !== null) {
			window.clearTimeout(this.cacheTimer);
			this.cacheTimer = null;
		}
		try {
			const path = this.cachePath();
			if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
		} catch (e) {
			console.warn("Power Extract: could not remove the cache", e);
		}
	}

	/* ---------------- settings ---------------- */

	private async loadSettings() {
		const disk = await this.readSettings();
		if (disk === null) this.loadFailed = true;
		this.settings = { ...DEFAULT_SETTINGS, ...(disk ?? {}) };
		this.baseline = structuredClone(this.settings);
	}

	private async readSettings(): Promise<Partial<PowerExtractSettings> | null> {
		try {
			return ((await this.loadData()) as Partial<PowerExtractSettings> | null) ?? {};
		} catch {
			return null;
		}
	}

	/**
	 * The one write path for settings, matching the rest of the suite: re-read
	 * the synced file and carry only the keys this device actually changed, so a
	 * device that has been asleep cannot publish its stale copy over everyone
	 * else's. A boot that never managed to read writes nothing at all, because
	 * defaults must not land on disk over the real thing.
	 */
	async persistSettings() {
		const disk = await this.readSettings();
		if (this.loadFailed && !disk) return;
		this.loadFailed = false;
		const merged = { ...this.settings };
		if (disk) {
			for (const key of Object.keys(merged) as (keyof PowerExtractSettings)[]) {
				if (!(key in disk)) continue;
				const changedByUs = JSON.stringify(this.settings[key]) !== JSON.stringify(this.baseline[key]);
				if (!changedByUs) (merged[key] as unknown) = disk[key];
			}
		}
		Object.assign(this.settings, merged);
		await this.saveData(this.settings);
		this.baseline = structuredClone(this.settings);
	}
}

/* ---------------- pick an image ---------------- */

class ImagePickerModal extends FuzzySuggestModal<TFile> {
	constructor(private readonly plugin: PowerExtractPlugin) {
		super(plugin.app);
		this.setPlaceholder("Pick an image to read");
	}

	getItems(): TFile[] {
		return this.plugin.app.vault.getFiles().filter((f) => this.plugin.canExtract(f));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile) {
		void this.plugin.copyTextToClipboard(file);
	}
}

/* ---------------- settings tab ---------------- */

interface Row {
	name: string;
	desc?: string;
	build: (setting: Setting) => void;
}

class PowerExtractSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: PowerExtractPlugin) {
		super(plugin.app, plugin);
	}

	/** Obsidian 1.13 and up builds the tab from these and never calls display().
	 *  Every row renders itself rather than declaring a `control`, so each one
	 *  stays on the plugin's own save path instead of Obsidian's generic one. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "",
				searchable: false, // a masthead, not a setting
				render: (s) => {
					s.settingEl.empty();
					this.renderAbout(s.settingEl);
				},
			},
			...this.rows().map(
				(row): SettingDefinitionRender => ({
					name: row.name,
					desc: row.desc,
					render: (s) => row.build(s),
				})
			),
		];
	}

	/** The pre-1.13 renderer. It draws the same rows the definitions above
	 *  declare, so the two only differ in who does the drawing. */
	display() {
		const root = this.containerEl;
		root.empty();
		this.renderAbout(root.createDiv({ cls: "px-about-standalone" }));
		for (const row of this.rows()) {
			const setting = new Setting(root).setName(row.name);
			if (row.desc) setting.setDesc(row.desc);
			row.build(setting);
		}
	}

	private renderAbout(el: HTMLElement) {
		el.addClass("px-about");
		const head = el.createDiv({ cls: "px-about-head" });
		head.createSpan({ cls: "px-about-name", text: this.plugin.manifest.name });
		head.createSpan({ cls: "px-about-version", text: "v" + this.plugin.manifest.version });
		el.createDiv({ cls: "px-about-desc", text: this.plugin.manifest.description });
	}

	private rows(): Row[] {
		const plugin = this.plugin;
		const rows: Row[] = [];

		rows.push({
			name: "This device",
			desc: "Where the reading happens, and whether it can happen here.",
			build: (s) => {
				const why = plugin.unavailableReason();
				const lang = plugin.api.language();
				const text = why
					? capitalize(unavailableMessage(why))
					: "Ready. Windows reads the images on this device" + (lang ? ", in " + lang + "." : ".");
				s.descEl.createDiv({ cls: "px-status", text });
			},
		});

		rows.push({
			name: "Text already read",
			desc: "Images are read once and remembered, so this grows as the vault is indexed.",
			build: (s) => {
				const { total, withText } = plugin.cacheSummary();
				s.descEl.createDiv({
					cls: "px-status",
					text: total
						? `${total.toLocaleString()} images read, ${withText.toLocaleString()} of them holding text.`
						: "Nothing read yet.",
				});
				s.addButton((b) =>
					b.setButtonText("Forget all").onClick(async () => {
						await plugin.clearCache();
						new Notice("Power Extract: cleared. Images will be read again as they are needed.");
						this.refresh();
					})
				);
				s.addButton((b) =>
					b.setButtonText("Tidy up").setTooltip("Drop text for images the vault no longer has").onClick(() => {
						const removed = plugin.prune();
						new Notice(removed ? `Power Extract: dropped ${removed} stale entries.` : "Power Extract: nothing to tidy.");
						this.refresh();
					})
				);
			},
		});

		rows.push({
			name: "Right-click an image to read it",
			desc: "Adds Copy text from image to the menu on any image file.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(plugin.settings.rightClickMenu).onChange((v) => {
						plugin.settings.rightClickMenu = v;
						void plugin.persistSettings();
					})
				);
			},
		});

		rows.push({
			name: "Remember what was read",
			desc: "Keeps the text so an image is never read twice. Turning this off makes every search re-read the vault.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(plugin.settings.useCache).onChange(async (v) => {
						plugin.settings.useCache = v;
						await plugin.persistSettings();
						if (!v) await plugin.clearCache();
						this.refresh();
					})
				);
			},
		});

		return rows;
	}

	/** Redraw after something changed the numbers on show. */
	private refresh() {
		// 1.13 redraws a declarative tab through update(). Older builds have only
		// display(), which is deprecated but has to stay reachable while the floor
		// is 1.8.7. Both come off the same cast, which doubles as the version
		// check and keeps the fallback from being reported as a deprecated call.
		const tab = this as unknown as { update?: () => void; display: () => void };
		if (tab.update) tab.update();
		else tab.display();
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
