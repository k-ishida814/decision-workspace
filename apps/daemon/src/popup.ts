/**
 * The Popup queue (T-602, design/ui-modes.md §4.1): at most one Popup window at a time. Each
 * batch of questions gets its own short-lived Popup process: `show` goes to its stdin, and its
 * stdout says `shown`, then one final message. Anything unexpected (cannot start, not shown in
 * time, exits without an answer, bad output) ends as a fallback to Claude Code's own UI.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { encode, LineDecoder } from "@dw/ipc-client";
import { type PopupAnswer, PopupOut, type PopupShow } from "@dw/protocol";

export type PopupJob = { project: string; batchId: string };

export type PopupResult =
  | { type: "answer"; answers: PopupAnswer[] }
  | { type: "fallback"; reason: string }
  | { type: "toWorkspace" };

export type PopupDeps = {
  /** How to start the Popup; undefined = no Popup available (every job falls back). */
  command: () => string[] | undefined;
  /** The message for a job, or undefined if its questions were settled meanwhile. */
  show: (job: PopupJob, more: number) => PopupShow | undefined;
  done: (job: PopupJob, result: PopupResult) => void;
  /** How long the Popup may take to report `shown`. */
  shownTimeoutMs: number;
  log: (message: string) => void;
};

type Current = { job: PopupJob; child?: ChildProcess; timer?: ReturnType<typeof setTimeout> };

const same = (a: PopupJob, b: PopupJob) => a.project === b.project && a.batchId === b.batchId;

export class PopupQueue {
  private queue: PopupJob[] = [];
  private current: Current | undefined;
  private closed = false;

  constructor(private readonly deps: PopupDeps) {}

  enqueue(job: PopupJob): void {
    if (this.has(job)) return;
    this.queue.push(job);
    this.pump();
  }

  /** Is this batch waiting for or showing a Popup? */
  has(job: PopupJob): boolean {
    return (
      (this.current !== undefined && same(this.current.job, job)) ||
      this.queue.some((j) => same(j, job))
    );
  }

  /** The batch was settled elsewhere (Workspace, Claude Code): close or drop its Popup. */
  withdraw(job: PopupJob): void {
    this.queue = this.queue.filter((j) => !same(j, job));
    if (this.current && same(this.current.job, job)) {
      this.deps.log(`popup for ${job.batchId}: withdrawn`);
      this.stop(this.current);
      this.current = undefined;
      this.pump();
    }
  }

  /** Daemon shutdown: close the Popup; waiting jobs are dropped (their hooks are abandoned). */
  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.current) this.stop(this.current);
    this.current = undefined;
  }

  private stop(c: Current): void {
    if (c.timer) clearTimeout(c.timer);
    c.child?.removeAllListeners("close");
    c.child?.kill("SIGTERM");
  }

  private finish(c: Current, result: PopupResult): void {
    if (this.current !== c) return; // already finished or withdrawn
    if (c.timer) clearTimeout(c.timer);
    this.current = undefined;
    this.deps.log(`popup for ${c.job.batchId}: ${result.type}`);
    this.deps.done(c.job, result);
    this.pump();
  }

  private pump(): void {
    while (!this.closed && !this.current && this.queue.length > 0) {
      const job = this.queue.shift() as PopupJob;
      const message = this.deps.show(job, this.queue.length);
      if (!message) continue; // settled while it waited
      const c: Current = { job };
      this.current = c;
      const command = this.deps.command();
      if (!command || command.length === 0) {
        this.finish(c, { type: "fallback", reason: "no popup installed" });
        continue;
      }
      this.launch(c, command, message);
    }
  }

  private launch(c: Current, command: string[], message: PopupShow): void {
    const [file, ...args] = command as [string, ...string[]];
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
    c.child = child;
    child.on("error", (error) =>
      this.finish(c, { type: "fallback", reason: `popup failed to start: ${error.message}` }),
    );
    // "close" (not "exit"): stdout is fully read by then, so a final answer is never lost.
    child.on("close", () => this.finish(c, { type: "fallback", reason: "popup closed" }));
    child.stdin?.on("error", () => {}); // it may exit before reading
    child.stdin?.write(encode(message));
    c.timer = setTimeout(() => {
      this.stop(c);
      this.finish(c, { type: "fallback", reason: "popup was not shown in time" });
    }, this.deps.shownTimeoutMs);

    const decoder = new LineDecoder();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        let parsed: ReturnType<typeof PopupOut.safeParse>;
        try {
          parsed = PopupOut.safeParse(JSON.parse(line));
        } catch {
          continue; // not JSON: ignore stray output
        }
        if (!parsed.success) continue;
        const out = parsed.data;
        if (out.type === "shown") {
          if (c.timer) clearTimeout(c.timer);
          c.timer = undefined;
          continue;
        }
        this.stop(c); // the final message: the Popup is done
        this.finish(
          c,
          out.type === "answer"
            ? { type: "answer", answers: out.answers }
            : out.type === "toWorkspace"
              ? { type: "toWorkspace" }
              : { type: "fallback", reason: "user chose Claude Code's UI" },
        );
      }
    });
  }
}
