// Node unit tests for the parts that hold no Obsidian. Run: npm test

// The engine schedules through window.setTimeout, which is what Obsidian wants
// so a timer belongs to the popout window it was started in. Node has no
// window, so point one at the global and the timers resolve to Node's own.
(globalThis as { window?: unknown }).window ??= globalThis;

import { CACHE_VERSION, type CacheMap, cacheStats, isFresh, parseCache, pruneCache, serializeCache } from "../src/cache";
import { OcrEngine, type WorkerProcess, unavailableMessage } from "../src/ocr";
import { OCR_WORKER_PS1 } from "../src/worker";
import { compareVersions, isDowngrade, versionFromManifest } from "../deploy-guard.mjs";

let failures = 0;
function ok(cond: unknown, msg: string) {
	if (cond) console.log("  ok -", msg);
	else {
		failures++;
		console.error("  FAIL -", msg);
	}
}
function eq(a: unknown, b: unknown, msg: string) {
	const sa = JSON.stringify(a);
	const sb = JSON.stringify(b);
	if (sa === sb) console.log("  ok -", msg);
	else {
		failures++;
		console.error("  FAIL -", msg, "\n    got:     ", sa, "\n    expected:", sb);
	}
}

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A rejected promise's message, or "(resolved)" when it did not reject.
 *
 * Call this the moment the promise is made, not at the moment you want to read
 * it. Several of these tests reject a promise and then await something else
 * before checking it, and an unhandled rejection in that gap takes the whole
 * suite down with a stack trace instead of a failing assertion. Calling this
 * runs as far as its first await synchronously, which attaches the handler.
 */
async function rejection(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "(resolved)";
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

// --- the worker script ships intact ---
{
	console.log("\nworker script");
	const nonAscii = [...OCR_WORKER_PS1].filter((c) => c.charCodeAt(0) > 126);
	// Windows PowerShell reads a .ps1 as ANSI unless it finds a BOM, and the
	// plugin writes this file without one, so anything above ASCII would arrive
	// as mojibake inside the script itself.
	eq(nonAscii, [], "the script is plain ASCII");
	// PowerShell's escape character is JavaScript's template delimiter. A script
	// that needs stitching around them is one careless edit from silently
	// becoming a different script, so it does without.
	eq(OCR_WORKER_PS1.includes("`"), false, "the script contains no backticks");
	// String.raw does not stop ${...}: an interpolation left in here would have
	// been substituted at build time rather than shipped.
	eq(OCR_WORKER_PS1.includes("${"), false, "nothing in the script looks like an interpolation");
	ok(OCR_WORKER_PS1.includes("TryCreateFromUserProfileLanguages"), "it creates a recognizer");
	ok(OCR_WORKER_PS1.includes("@@quit"), "it honors the quit message");
}

// --- cache ---
{
	console.log("\ncache");
	const map: CacheMap = { "a.png": { m: 10, s: 100, t: "hello" }, "b.png": { m: 20, s: 200, t: "" } };

	ok(isFresh(map["a.png"], 10, 100), "an entry matching mtime and size is fresh");
	ok(!isFresh(map["a.png"], 11, 100), "a newer mtime is not");
	// A file restored from a backup or dragged in by a sync can carry an old
	// mtime with different bytes, and size is what notices.
	ok(!isFresh(map["a.png"], 10, 101), "nor is the same mtime at a different size");
	ok(!isFresh(undefined, 10, 100), "and nothing cached is never fresh");

	eq(parseCache(serializeCache(map)), map, "a cache survives the round trip");
	eq(parseCache(null), {}, "no file reads as an empty cache");
	eq(parseCache("{ not json"), {}, "and so does a corrupt one, rather than throwing");
	eq(parseCache('{"v":999,"e":{"a.png":{"m":1,"s":1,"t":"x"}}}'), {}, "a cache from a future version is not adopted");
	eq(parseCache('{"e":{}}'), {}, "a file with no version is not either");
	// One bad row should cost one image, not the whole vault's work.
	eq(parseCache(`{"v":${CACHE_VERSION},"e":{"good.png":{"m":1,"s":2,"t":"x"},"bad.png":{"m":"nope"}}}`), {
		"good.png": { m: 1, s: 2, t: "x" },
	}, "a malformed entry drops itself and leaves the rest");

	const pruned = pruneCache(map, new Set(["a.png"]));
	eq(pruned.map, { "a.png": { m: 10, s: 100, t: "hello" } }, "pruning keeps what the vault still has");
	eq(pruned.removed, 1, "and reports what it dropped");
	eq(pruneCache(map, new Set(["a.png", "b.png"])).removed, 0, "a cache with nothing stale is left alone");

	// An image that holds no text is a real answer worth caching: it is what
	// stops a vault of photographs being re-read on every launch.
	eq(cacheStats(map), { total: 2, withText: 1, chars: 5 }, "stats count the blanks but do not credit them");
	eq(cacheStats({}), { total: 0, withText: 0, chars: 0 }, "an empty cache reports zeroes");
}

// --- the OCR engine's lifecycle ---

/** A stand-in for the PowerShell worker: records what it was sent and lets a
 *  test answer, die, or say nothing at all. */
class FakeWorker implements WorkerProcess {
	sent: string[] = [];
	killed = false;
	ended = false;
	private dataCb: ((chunk: string) => void) | null = null;
	private closeCb: (() => void) | null = null;

	stdin = {
		write: (chunk: string) => {
			if (this.ended) throw new Error("write after end");
			this.sent.push(chunk);
		},
		end: () => {
			this.ended = true;
		},
	};
	stdout = {
		setEncoding: () => {},
		on: (_event: "data", cb: (chunk: string) => void) => {
			this.dataCb = cb;
		},
	};
	stderr = { setEncoding: () => {}, on: () => {} };

	// Only close is ever exercised here: a fake process has nothing to error
	// about, and the engine treats the two the same way regardless.
	on(event: "close" | "error", cb: (err: Error) => void): void {
		if (event === "close") this.closeCb = cb as () => void;
	}
	kill() {
		this.killed = true;
		// A real process does not stop the instant it is killed: its close event
		// lands a tick later, by which time the engine may already have started
		// a replacement. Firing it late here is what keeps that case honest.
		setTimeout(() => this.closeCb?.(), 0);
	}

	/** Push a raw chunk, so a test can split a line across two reads. */
	emit(chunk: string) {
		this.dataCb?.(chunk);
	}
	ready(lang = "en-US") {
		this.emit(JSON.stringify({ ready: true, lang }) + "\n");
	}
	/** The id of the nth job this worker was handed. */
	jobId(n = 0): string {
		return this.sent[n]?.split("\t")[0] ?? "";
	}
	jobPath(n = 0): string {
		return (this.sent[n] ?? "").split("\t")[1]?.trim() ?? "";
	}
	answer(text: string, n = 0) {
		this.emit(JSON.stringify({ id: this.jobId(n), text }) + "\n");
	}
	fail(err: string, n = 0) {
		this.emit(JSON.stringify({ id: this.jobId(n), err }) + "\n");
	}
	die() {
		this.closeCb?.();
	}
}

/** An engine wired to a fresh FakeWorker per spawn, with the spawns recorded. */
function harness(opts: { idleMs?: number; jobMs?: number } = {}) {
	const workers: FakeWorker[] = [];
	const engine = new OcrEngine({
		spawn: () => {
			const w = new FakeWorker();
			workers.push(w);
			return w;
		},
		idleMs: opts.idleMs ?? 30_000,
		jobMs: opts.jobMs ?? 30_000,
		log: () => {},
	});
	return { engine, workers, last: () => workers[workers.length - 1] };
}

async function lifecycleTests() {
	console.log("\nOCR engine");

	// the ordinary path
	{
		const { engine, workers, last } = harness();
		const p = engine.extract("C:\\vault\\shot.png");
		await wait();
		eq(workers.length, 1, "the first extraction starts a worker");
		// Nothing is sent until the worker says it has an engine: a job written
		// into a process that is still standing up would be answered by nobody.
		eq(last().sent.length, 0, "and nothing is sent before it says it is ready");
		last().ready();
		await wait();
		eq(last().jobPath(), "C:\\vault\\shot.png", "the path goes over once it is");
		last().answer("hello there");
		eq(await p, "hello there", "and the text comes back");
		eq(engine.language, "en-US", "the recognizer's language is remembered for the settings tab");
	}

	// one worker, many images
	{
		const { engine, workers, last } = harness();
		const a = engine.extract("a.png");
		const b = engine.extract("b.png");
		await wait();
		last().ready();
		await wait();
		// Serial on purpose: one process holds one engine, and at 35ms an image
		// there is nothing to gain from pipelining.
		eq(last().sent.length, 1, "images are sent one at a time");
		last().answer("first", 0);
		await wait();
		eq(last().sent.length, 2, "the next goes out when the last is answered");
		last().answer("second", 1);
		eq(await a, "first", "the first caller gets the first answer");
		eq(await b, "second", "and the second gets the second");
		eq(workers.length, 1, "both were read by the same worker");
	}

	// a result split across two reads
	{
		const { engine, last } = harness();
		const p = engine.extract("a.png");
		await wait();
		last().ready();
		await wait();
		const id = last().jobId();
		last().emit('{"id":"' + id + '","text":"split ');
		last().emit('over two reads"}\n');
		eq(await p, "split over two reads", "a line arriving in pieces is still one result");
	}

	// a file the worker could not read
	{
		const { engine, last } = harness();
		const p = engine.extract("broken.png");
		await wait();
		last().ready();
		await wait();
		last().fail("Could not find file 'broken.png'.");
		eq(await rejection(p), "Could not find file 'broken.png'.", "a failed image reports why");
		const next = engine.extract("fine.png");
		await wait();
		// The worker reports a bad file as data and stays up, so the queue keeps
		// moving rather than restarting around every unreadable image. Same
		// worker, so this is its second job.
		last().answer("still here", 1);
		eq(await next, "still here", "and the worker stays up for the next one");
	}

	// this machine has no recognizer
	{
		const { engine, workers, last } = harness();
		const p = engine.extract("a.png");
		await wait();
		last().emit('{"ready":false}\n');
		ok((await rejection(p)).includes("no OCR language"), "a machine with no recognizer says so");
		eq(engine.unavailable, "no-engine", "and the engine remembers it");
		const second = engine.extract("b.png");
		ok((await rejection(second)).includes("no OCR language"), "later calls fail the same way");
		// The whole point of remembering: a vault sweep must not start 13,000
		// processes to be told the same thing 13,000 times.
		eq(workers.length, 1, "without starting another worker to ask again");
	}

	// the worker dies mid-image
	{
		const { engine, workers, last } = harness();
		const dying = rejection(engine.extract("a.png"));
		const queued = engine.extract("b.png");
		await wait();
		last().ready();
		await wait();
		last().die();
		await wait();
		ok((await dying).includes("stopped before it answered"), "the image it was holding fails");
		eq(workers.length, 2, "and a new worker starts for what is still queued");
		last().ready();
		await wait();
		eq(last().jobPath(), "b.png", "which picks up the queue where it left off");
		last().answer("recovered");
		eq(await queued, "recovered", "and finishes it");
	}

	// a worker that dies on startup, over and over
	{
		const { engine, workers } = harness();
		const p = rejection(engine.extract("a.png"));
		await wait();
		for (let i = 0; i < 4; i++) {
			workers[workers.length - 1].die();
			await wait();
		}
		ok((await p).includes("would not start"), "an engine that never starts eventually says so");
		// Three tries, not one per image: a machine where this cannot work costs
		// a handful of spawns rather than one for every screenshot in the vault.
		eq(workers.length, 3, "after a bounded number of attempts");
		eq(engine.unavailable, "failed", "and it stops trying");
	}

	// a crash after real work does not count against the startup budget
	{
		const { engine, workers, last } = harness();
		const first = engine.extract("a.png");
		await wait();
		last().ready();
		await wait();
		last().answer("worked");
		await first;
		for (let i = 0; i < 3; i++) {
			last().die();
			await wait();
			const p = engine.extract("b.png");
			await wait();
			last().ready();
			await wait();
			last().answer("still working");
			await p;
		}
		eq(engine.unavailable, null, "a worker that has delivered gets a fresh budget after each crash");
		ok(workers.length > 3, "so it keeps restarting for as long as it keeps working");
	}

	// an answer to a job nobody is waiting for
	{
		const { engine, last } = harness();
		const p = engine.extract("a.png");
		await wait();
		last().ready();
		await wait();
		last().emit('{"id":"999","text":"not yours"}\n');
		last().emit("this is not json at all\n");
		last().answer("mine");
		// Resolving on an id we are not waiting for would hand one caller another
		// caller's text, which is worse than any error.
		eq(await p, "mine", "a stray result is ignored and the real one still lands");
	}

	// an image that wedges the engine
	{
		const { engine, workers, last } = harness({ jobMs: 20 });
		const stuck = rejection(engine.extract("wedged.png"));
		const queued = engine.extract("next.png");
		await wait();
		last().ready();
		await wait();
		const retired = last();
		await wait(40);
		ok(retired.killed, "an image that never comes back gets the worker killed");
		ok((await stuck).includes("took too long"), "and the caller is told which way it failed");
		// One unreadable image must not cost the vault the rest of its sweep.
		eq(workers.length, 2, "a fresh worker starts for what was behind it");
		last().ready();
		await wait();
		eq(last().jobPath(), "next.png", "which carries on with the queue");
		last().answer("carried on");
		eq(await queued, "carried on", "and delivers it");

		// The retired process is still out there. Its close event and anything
		// left in its pipe arrive now, after a new worker has taken a job.
		retired.emit('{"id":"' + last().jobId() + '","text":"from the dead"}\n');
		retired.die();
		await wait();
		eq(workers.length, 2, "a retired worker's parting words start nothing");
		ok(!engine.unavailable, "and count against nothing");
	}

	// the worker goes home when there is nothing to do
	{
		const { engine, last } = harness({ idleMs: 20 });
		const p = engine.extract("a.png");
		await wait();
		last().ready();
		await wait();
		last().answer("done");
		await p;
		ok(engine.running, "the worker is still up right after an image");
		await wait(40);
		ok(!engine.running, "and shuts down once it has been idle");
		ok(last().killed, "leaving no powershell behind");
		// Going idle is not failing, so the next image starts a fresh worker.
		const second = engine.extract("b.png");
		await wait();
		last().ready();
		await wait();
		last().answer("back");
		eq(await second, "back", "and the next image starts one again");
	}

	// unloading
	{
		const { engine, last } = harness();
		const p = engine.extract("a.png");
		await wait();
		last().ready();
		await wait();
		const queued = rejection(engine.extract("b.png"));
		const inFlight = rejection(p);
		engine.stop();
		ok(last().killed, "unloading kills the worker");
		ok((await inFlight).includes("unloading"), "the image in flight is told");
		ok((await queued).includes("unloading"), "and so is everything queued");
		ok((await rejection(engine.extract("c.png"))).includes("unloading"), "and nothing new is accepted");
	}

	// the messages people actually read
	{
		console.log("\nmessages");
		ok(unavailableMessage("no-node").includes("desktop"), "mobile is told it needs the desktop app");
		ok(unavailableMessage("not-windows").includes("Windows"), "macOS and Linux are told what is missing");
		ok(unavailableMessage("no-engine").includes("Settings"), "a Windows box with no language is told where to add one");
		ok(unavailableMessage("failed").length > 0, "and a worker that will not start says something");
	}
}

// --- the deploy guard's version arithmetic ---
{
	console.log("\ndeploy guard");
	eq(compareVersions("1.10.0", "1.9.0") > 0, true, "10 is a later minor than 9, not an earlier one");
	eq(compareVersions("1.0.0", "1.0.0"), 0, "the same version ties");
	eq(isDowngrade("1.1.0", "1.0.0"), true, "deploying an older build over a newer one is the collision this catches");
	eq(isDowngrade(null, "1.0.0"), false, "a vault with nothing installed has nothing to lose");
	eq(versionFromManifest('{"version":"1.0.0"}'), "1.0.0", "a manifest names its version");
	eq(versionFromManifest("{ not json"), null, "and a broken one names none");
}

// Every lifecycle test waits on a promise the fake worker is supposed to
// settle. Get one of those wrong and the suite simply stops: node runs out of
// work, exits 0, and a truncated log reads like a pass. This is what makes a
// hang fail out loud instead.
const watchdog = setTimeout(() => {
	console.error("\nTests hung: a promise was never settled. The output above stops at the culprit.");
	process.exit(1);
}, 20_000);

lifecycleTests().then(() => {
	clearTimeout(watchdog);
	if (failures) {
		console.error(`\n${failures} test(s) FAILED.`);
		process.exit(1);
	}
	console.log("\nAll tests passed.");
});
