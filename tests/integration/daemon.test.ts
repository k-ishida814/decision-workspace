import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, DISCONNECT_REASON, startDaemon } from "@dw/daemon";
import { DaemonUnavailableError, DwClient, type RpcCallError } from "@dw/ipc-client";
import { type DwEvent, ErrorCode } from "@dw/protocol";

let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon | undefined;
const clients: DwClient[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dw-it-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "project");
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await daemon?.close();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<Daemon> {
  daemon = await startDaemon({ socketPath });
  return daemon;
}

async function client(): Promise<DwClient> {
  const c = await DwClient.connect({ socketPath });
  clients.push(c);
  return c;
}

function collect(c: DwClient): DwEvent[] {
  const events: DwEvent[] = [];
  c.onEvent((e) => events.push(e));
  return events;
}

async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

const questions = [
  { question: "Lang?", header: "Lang", options: [{ label: "TS" }, { label: "Rust" }] },
  { question: "Editors?", multiSelect: true, options: [{ label: "VS Code" }, { label: "Zed" }] },
];

describe("daemon + client", () => {
  test("socket is owner-only (NFR-07) and ping works", async () => {
    await start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const c = await client();
    expect((await c.call("daemon.ping", {})).pid).toBe(process.pid);
  });

  test("an update from one client is pushed to another (T-104, DQ-09)", async () => {
    await start();
    const tui = await client();
    const cli = await client();
    const events = collect(tui);
    await tui.call("events.subscribe", { project });
    const [d] = await cli.call("decision.create", {
      project,
      decisions: [{ question: "DB?", kind: "single", options: [{ id: "a", label: "SQLite" }] }],
    });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: "decision.created", decision: { id: "D-1" } });

    await cli.call("decision.answer", {
      project,
      id: "D-1",
      expectedVersion: d?.version ?? 0,
      answer: { selected: ["a"] },
    });
    await until(() => events.length === 2);
    expect(events[1]?.decision.status).toBe("decided");
  });

  test("askBatch waits until every question is answered, then returns AskUserQuestion answers", async () => {
    await start();
    const hook = await client();
    const tui = await client();
    let result: unknown;
    const waiting = hook
      .call("decision.askBatch", { project, batchId: "toolu_1", sessionId: "s1", questions })
      .then((r) => {
        result = r;
      });

    await until(() => result === undefined); // still waiting
    const open = await tui.call("decision.list", { project, status: ["ready"] });
    expect(open.map((d) => d.question)).toEqual(["Lang?", "Editors?"]);

    await tui.call("decision.answer", {
      project,
      id: "D-1",
      expectedVersion: 1,
      answer: { selected: ["2"] },
    });
    await Bun.sleep(30);
    expect(result).toBeUndefined(); // one of two answered: keep waiting
    await tui.call("decision.answer", {
      project,
      id: "D-2",
      expectedVersion: 1,
      answer: { selected: ["1", "2"] },
    });
    await waiting;
    expect(result).toEqual({
      status: "answered",
      answers: { "Lang?": "Rust", "Editors?": "VS Code, Zed" },
    });
  });

  test("askBatch for the same tool_use_id reuses the decisions", async () => {
    await start();
    const tui = await client();
    const first = await client();
    void first
      .call("decision.askBatch", { project, batchId: "toolu_1", questions })
      .catch(() => {});
    await Bun.sleep(30);
    const again = await client();
    void again
      .call("decision.askBatch", { project, batchId: "toolu_1", questions })
      .catch(() => {});
    await Bun.sleep(30);
    expect(await tui.call("decision.list", { project })).toHaveLength(2);
  });

  test("fallback returns { status: fallback } to the waiting hook", async () => {
    await start();
    const hook = await client();
    const tui = await client();
    const waiting = hook.call("decision.askBatch", { project, batchId: "toolu_1", questions });
    await Bun.sleep(30);
    await tui.call("decision.fallback", { project, batchId: "toolu_1" });
    expect(await waiting).toEqual({ status: "fallback" });
  });

  test("when the waiting hook disconnects (Esc / timeout), its questions are cancelled (ADR-0004)", async () => {
    await start();
    const hook = await client();
    const tui = await client();
    const events = collect(tui);
    await tui.call("events.subscribe", {});
    hook.call("decision.askBatch", { project, batchId: "toolu_1", questions }).catch(() => {});
    await until(() => events.length === 2); // created ×2
    hook.close();
    await until(() => events.length === 4);
    expect(events.slice(2).map((e) => [e.decision.status, e.decision.closedReason])).toEqual([
      ["cancelled", DISCONNECT_REASON],
      ["cancelled", DISCONNECT_REASON],
    ]);
  });

  test("errors carry JSON-RPC codes: conflict, invalid params, not found", async () => {
    await start();
    const c = await client();
    await c.call("decision.create", { project, decisions: [{ question: "Q?", kind: "text" }] });
    await c.call("decision.answer", {
      project,
      id: "D-1",
      expectedVersion: 1,
      answer: { text: "a" },
    });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 0,
        (e: RpcCallError) => e.code,
      );
    expect(
      await code(
        c.call("decision.answer", {
          project,
          id: "D-1",
          expectedVersion: 1,
          answer: { text: "b" },
        }),
      ),
    ).toBe(ErrorCode.Conflict);
    expect(await code(c.call("decision.get", { project, id: "D-9" }))).toBe(ErrorCode.NotFound);
    expect(await code(c.call("decision.list", { project: "relative/path" }))).toBe(
      ErrorCode.InvalidParams,
    );
    expect(await code(c.call("decision.create", { project, decisions: [] } as never))).toBe(
      ErrorCode.InvalidParams,
    );
  });
});

describe("lifecycle", () => {
  test("client starts the daemon on demand (T-105)", async () => {
    let started = 0;
    const c = await DwClient.connect({
      socketPath,
      autoStart: () => {
        started++;
        void start();
      },
    });
    clients.push(c);
    expect(started).toBe(1);
    expect((await c.call("daemon.ping", {})).version).toBeString();
  });

  test("without autoStart, a missing daemon is DaemonUnavailableError (hook fail-open relies on this)", async () => {
    await expect(DwClient.connect({ socketPath })).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  test("refuses to start twice; replaces a stale socket file", async () => {
    await start();
    await expect(startDaemon({ socketPath })).rejects.toThrow("already listening");
    await daemon?.close();
    writeFileSync(socketPath, ""); // stale leftover from a crash
    await start();
    expect((await (await client()).call("daemon.ping", {})).pid).toBe(process.pid);
  });

  test("calls in flight fail when the daemon goes away", async () => {
    await start();
    const c = await client();
    const waiting = c.call("decision.askBatch", { project, batchId: "t", questions });
    await Bun.sleep(30);
    await daemon?.close();
    daemon = undefined;
    await expect(waiting).rejects.toBeInstanceOf(DaemonUnavailableError);
  });
});
