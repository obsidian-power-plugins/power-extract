/**
 * The OCR worker's keeper: starts it, feeds it one job at a time, and cleans up
 * after it when it dies.
 *
 * Deliberately knows nothing about Obsidian or the filesystem. It is handed a
 * function that starts a process and a path to point it at, which is what lets
 * the tests drive the whole lifecycle (a worker that never becomes ready, one
 * that dies mid-job, one that answers out of order) against a fake process
 * instead of a real PowerShell.
 */

/** The slice of a Node child process this needs. Narrow on purpose: a real
 *  ChildProcess satisfies it structurally, and so does a few lines of test
 *  double. */
export interface WorkerProcess {
	stdin: { write(chunk: string): void; end(): void };
	stdout: { setEncoding(enc: string): void; on(event: "data", cb: (chunk: string) => void): void };
	stderr: { setEncoding(enc: string): void; on(event: "data", cb: (chunk: string) => void): void };
	/** One signature for both events: a close handler is free to ignore the
	 *  argument, and keeping it single-signature is what lets a test double
	 *  satisfy this without a cast at every call site. */
	on(event: "close" | "error", cb: (err: Error) => void): void;
	kill(): void;
}

export type SpawnWorker = () => WorkerProcess;

export interface OcrEngineOptions {
	spawn: SpawnWorker;
	/** Stop the worker after this long with nothing to do. A held process is
	 *  cheap but not free, and a powershell.exe still sitting there an hour
	 *  after the last screenshot is the kind of thing people rightly ask
	 *  about. */
	idleMs?: number;
	/** Give up on a single image after this long. Reached only if the engine
	 *  wedges: the slowest image measured in a 13,000-image vault was under a
	 *  second. */
	jobMs?: number;
	/** Somewhere for the unexpected to go. */
	log?: (message: string, detail?: unknown) => void;
}

/** Why the engine will not run, when it will not. */
export type OcrUnavailable =
	| "not-windows" // no PowerShell to host WinRT
	| "no-node" // mobile: no child processes at all
	| "no-engine" // Windows, but no recognizer installed for any profile language
	| "failed"; // it kept dying on startup

interface Job {
	id: string;
	path: string;
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

/** Consecutive starts that never produced a result before the process died.
 *  Past this the engine stops trying, so a machine where the worker cannot run
 *  costs a handful of spawns rather than one per image, forever. */
const MAX_FAILED_STARTS = 3;

export class OcrEngine {
	private proc: WorkerProcess | null = null;
	private ready = false;
	private queue: Job[] = [];
	private active: Job | null = null;
	private buf = "";
	private seq = 0;
	private failedStarts = 0;
	/**
	 * Which worker is the current one.
	 *
	 * A process does not go quiet the moment it is let go: its close event, and
	 * anything already in its pipe, arrive after the next worker has started and
	 * possibly after that worker has taken a job. Acting on either would reject
	 * or resolve a job belonging to a process that never saw it. Every handler
	 * carries the generation it was registered for and does nothing once that
	 * generation is history.
	 */
	private gen = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private jobTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	/** Set once the worker says it has no recognizer, so the next 13,000 images
	 *  do not each start a process to be told the same thing. */
	unavailable: OcrUnavailable | null = null;
	/** The recognizer's language tag, once known. Shown in settings, because
	 *  "why is my German screenshot coming out as nonsense" is answered by it. */
	language: string | null = null;

	private readonly idleMs: number;
	private readonly jobMs: number;
	private readonly log: (message: string, detail?: unknown) => void;

	constructor(private readonly opts: OcrEngineOptions) {
		this.idleMs = opts.idleMs ?? 30_000;
		this.jobMs = opts.jobMs ?? 30_000;
		this.log = opts.log ?? (() => {});
	}

	/** Text found in the image at `absPath`. Rejects if this machine cannot run
	 *  the engine at all, or if this one image could not be read. */
	extract(absPath: string): Promise<string> {
		if (this.stopped) return Promise.reject(new Error("Power Extract is unloading."));
		if (this.unavailable) return Promise.reject(new Error(unavailableMessage(this.unavailable)));
		return new Promise<string>((resolve, reject) => {
			this.queue.push({ id: String(++this.seq), path: absPath, resolve, reject });
			this.pump();
		});
	}

	/** Is a worker running right now? Only the settings tab cares. */
	get running(): boolean {
		return this.proc !== null;
	}

	/** Shut down for good: no restarts, no queue, no lingering process. */
	stop(reason = "Power Extract is unloading.") {
		this.stopped = true;
		this.clearIdle();
		this.clearJobTimer();
		// The image already sent to the worker is not in the queue, and the
		// worker is about to be retired, so nothing else is ever going to answer
		// for it. Whoever is waiting has to be told here or they wait forever.
		const active = this.active;
		this.active = null;
		this.failQueued(new Error(reason));
		active?.reject(new Error(reason));
		this.quit();
	}

	/* ---- the pump ---- */

	private pump() {
		if (this.stopped || this.active || !this.queue.length) return;
		if (!this.proc) {
			this.start();
			return; // the ready line calls back here
		}
		if (!this.ready) return; // starting; the ready line calls back here
		this.clearIdle();
		const job = this.queue.shift()!;
		this.active = job;
		this.jobTimer = setTimeout(() => {
			// A wedged engine cannot be asked politely to let go of the image it
			// is holding, and everything behind it waits until it does. Drop the
			// worker, fail this one image, and carry on with the rest: a single
			// bad file must not cost the vault its sweep.
			this.log("an image took too long and the worker was restarted", job.path);
			this.jobTimer = null;
			this.active = null;
			this.quit();
			job.reject(new Error("reading this image took too long."));
			this.pump();
		}, this.jobMs);
		try {
			this.proc.stdin.write(`${job.id}\t${job.path}\n`);
		} catch {
			// The pipe went away between the check and the write.
			this.clearJobTimer();
			this.active = null;
			this.queue.unshift(job);
			this.onClosed();
		}
	}

	private start() {
		if (this.failedStarts >= MAX_FAILED_STARTS) {
			this.markUnavailable("failed");
			return;
		}
		this.failedStarts++;
		let proc: WorkerProcess;
		try {
			proc = this.opts.spawn();
		} catch (e) {
			this.log("could not start the OCR worker", e);
			this.markUnavailable("failed");
			return;
		}
		const gen = ++this.gen;
		this.proc = proc;
		this.ready = false;
		this.buf = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk) => {
			if (gen === this.gen) this.onData(chunk);
		});
		proc.stderr.setEncoding("utf8");
		// PowerShell writes its own diagnostics here. The worker reports job
		// failures as data, so anything on this channel is unexpected and worth
		// keeping, but it is never the answer to a job.
		proc.stderr.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text) this.log("OCR worker stderr", text);
		});
		proc.on("error", (err) => {
			if (gen !== this.gen) return;
			this.log("OCR worker error", err);
			this.onClosed();
		});
		proc.on("close", () => {
			if (gen === this.gen) this.onClosed();
		});
	}

	private onData(chunk: string) {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) this.onLine(line);
		}
	}

	private onLine(line: string) {
		let msg: { ready?: boolean; lang?: string; id?: string; text?: string; err?: string };
		try {
			msg = JSON.parse(line);
		} catch {
			// Not ours. PowerShell will occasionally put a progress record or a
			// warning on stdout, and none of it is a job result.
			this.log("unrecognized line from the OCR worker", line.slice(0, 200));
			return;
		}

		if (msg.ready !== undefined) {
			if (!msg.ready) {
				this.markUnavailable("no-engine");
				this.quit();
				return;
			}
			this.ready = true;
			this.language = msg.lang ?? null;
			this.pump();
			return;
		}

		if (!this.active || msg.id !== this.active.id) {
			// A result for a job that already timed out, or one we never sent.
			// Dropping it is right; acting on it would resolve the wrong promise.
			this.log("ignored an out-of-band OCR result", msg.id);
			return;
		}

		const job = this.active;
		this.active = null;
		this.clearJobTimer();
		// One completed round trip proves the worker works on this machine, so
		// the crash-loop budget resets and a later crash gets a fresh three.
		this.failedStarts = 0;
		if (msg.err) job.reject(new Error(msg.err));
		else job.resolve(msg.text ?? "");
		if (this.queue.length) this.pump();
		else this.scheduleIdle();
	}

	private onClosed() {
		this.clearJobTimer();
		const wasActive = this.active;
		this.proc = null;
		this.ready = false;
		this.active = null;
		this.buf = "";
		if (wasActive) {
			wasActive.reject(new Error("the OCR worker stopped before it answered."));
		}
		if (this.stopped || this.unavailable) {
			this.failQueued(new Error(this.unavailable ? unavailableMessage(this.unavailable) : "Power Extract is unloading."));
			return;
		}
		// Anything still queued deserves another worker; start() is what decides
		// when enough is enough.
		if (this.queue.length) this.pump();
	}

	private markUnavailable(why: OcrUnavailable) {
		this.unavailable = why;
		this.failQueued(new Error(unavailableMessage(why)));
	}

	private failQueued(err: Error) {
		const queued = this.queue;
		this.queue = [];
		for (const job of queued) job.reject(err);
	}

	private scheduleIdle() {
		this.clearIdle();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (!this.active && !this.queue.length) this.quit();
		}, this.idleMs);
	}

	private clearIdle() {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private clearJobTimer() {
		if (this.jobTimer !== null) {
			clearTimeout(this.jobTimer);
			this.jobTimer = null;
		}
	}

	/** Ask the worker to leave, then make sure it did. Retiring the generation
	 *  first means its parting words land on nobody. */
	private quit() {
		const proc = this.proc;
		if (!proc) return;
		this.gen++;
		this.proc = null;
		this.ready = false;
		try {
			proc.stdin.write("@@quit\n");
			proc.stdin.end();
		} catch {
			// already gone
		}
		try {
			proc.kill();
		} catch {
			// already gone
		}
	}
}

/** What to tell someone who asked for text and cannot have any. */
export function unavailableMessage(why: OcrUnavailable): string {
	switch (why) {
		case "no-node":
			return "reading text from images needs the desktop app.";
		case "not-windows":
			return "reading text from images currently needs Windows.";
		case "no-engine":
			return "Windows has no OCR language installed. Add one under Settings > Time & language > Language & region, then reload Obsidian.";
		case "failed":
			return "the OCR worker would not start on this machine.";
	}
}
