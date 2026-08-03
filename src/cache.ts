/**
 * The extraction cache: what was read out of which image, so a vault full of
 * screenshots is only ever read once.
 *
 * Kept as one file rather than one file per image. The plugin this replaces
 * wrote a separate JSON per extraction and had accumulated 13,200 of them in a
 * folder that sync tools have to walk on every pass. The same content lives
 * here as a single object, and the keys are one character each because at that
 * count the key names were a meaningful share of the bytes.
 *
 * Nothing in this file touches Obsidian or the filesystem: it is handed strings
 * and answers questions about them, which is what makes it testable.
 */

/** Bumped only when an entry's meaning changes, which makes every existing
 *  entry stale and re-read. A new field that older entries can do without is
 *  not that. */
export const CACHE_VERSION = 1;

export interface CacheEntry {
	/** Modification time of the image when it was read. */
	m: number;
	/** Size in bytes when it was read. Paired with mtime because a file
	 *  restored from a backup or a sync can carry an older mtime with different
	 *  content, and the pair disagrees where either alone would not. */
	s: number;
	/** The text found. An empty string is a real answer, not a missing one: it
	 *  means the engine ran and the image holds no readable text, and caching
	 *  that is the whole reason a vault of photographs does not get re-read
	 *  every launch. */
	t: string;
}

export type CacheMap = Record<string, CacheEntry>;

interface CacheFile {
	v: number;
	e: CacheMap;
}

/** Is this entry still about the file on disk right now? */
export function isFresh(entry: CacheEntry | undefined, mtime: number, size: number): entry is CacheEntry {
	return !!entry && entry.m === mtime && entry.s === size;
}

/** Read a cache file. Anything unreadable, from any version, comes back empty
 *  rather than throwing: a corrupt cache costs one re-read of the vault, while
 *  a throw on load would take the whole plugin down with it. */
export function parseCache(raw: string | null | undefined): CacheMap {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const file = parsed as Partial<CacheFile>;
	if (file.v !== CACHE_VERSION || !file.e || typeof file.e !== "object") return {};
	const out: CacheMap = {};
	for (const [path, entry] of Object.entries(file.e as Record<string, unknown>)) {
		const e = entry as Partial<CacheEntry>;
		// One malformed entry drops itself, not the rest of the vault's work.
		if (typeof e?.m === "number" && typeof e.s === "number" && typeof e.t === "string") {
			out[path] = { m: e.m, s: e.s, t: e.t };
		}
	}
	return out;
}

export function serializeCache(map: CacheMap): string {
	const file: CacheFile = { v: CACHE_VERSION, e: map };
	return JSON.stringify(file);
}

/**
 * Drop entries for images the vault no longer has.
 *
 * Without this the file only ever grows: every screenshot ever pasted and later
 * deleted keeps its text forever, and the cost is paid on every load and every
 * sync. Renames look like a delete plus an add here, which re-reads one image
 * and is not worth tracking moves to avoid.
 */
export function pruneCache(map: CacheMap, livePaths: Set<string>): { map: CacheMap; removed: number } {
	const out: CacheMap = {};
	let removed = 0;
	for (const [path, entry] of Object.entries(map)) {
		if (livePaths.has(path)) out[path] = entry;
		else removed++;
	}
	return { map: out, removed };
}

/** What the settings tab reports: how much is cached and how much of it turned
 *  out to hold text. */
export function cacheStats(map: CacheMap): { total: number; withText: number; chars: number } {
	let withText = 0;
	let chars = 0;
	for (const e of Object.values(map)) {
		if (e.t) {
			withText++;
			chars += e.t.length;
		}
	}
	return { total: Object.keys(map).length, withText, chars };
}
