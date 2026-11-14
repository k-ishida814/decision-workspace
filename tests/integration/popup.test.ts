/** Routing questions to the Workspace, the Popup or Claude Code's UI (T-602, T-608). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeFor } from "@dw/core";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import type { AskBatchResult, PopupShow, UiMode } from "@dw/protocol";

const FAKE = join(import.meta.dir, "../fixtures/fake-popup.ts");
let dir: string;
let socketPath: string;
let project: string;
let log: string;
let daemon: Daemon;
let mode: UiMode;
let popupCommand: string[] | undefined;
const clients: DwClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-popup-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "p");
  log = join(dir, "popup.log");
  process.env.FAKE_POPUP_LOG = log;
  process.env.FAKE_POPUP = "answer";
  delete process.env.FAKE_POPUP_DELAY_MS;
  mode = "popup";
  popupCommand = ["bun", FAKE];
  daemon = await startDaemon({
    socketPath,
    mode: () => mode,
    popupCommand: () => popupCommand,
    popupShownTimeoutMs: 1500,
  });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function client(): Promise<DwClient> {
  const c = await DwClient.connect({ socketPath });
  clients.push(c);
  return c;
}

/** What the hook does: route: true, wait for the outcome. */
async function ask(
  batchId: string,
  questions = [{ question: "Storage?", options: [{ label: "SQLite" }, { label: "Cloud" }] }],
) {
  const c = await client();
  return c.call(
    "decision.askBatch",
    { project, batchId, sessionId: "session-1234567890", questions, route: true },
    { timeoutMs: 10_000 },
  );
}

const shows = (): { pid: number; show: PopupShow }[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(pred: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

test("routeFor: Workspace → Popup → Claude Code's UI", () => {
  expect([true, false].map((w) => routeFor("auto", w))).toEqual(["workspace", "popup"]);
  expect([true, false].map((w) => routeFor("workspace", w))).toEqual(["workspace", "fallback"]);
  expect([true, false].map((w) => routeFor("popup", w))).toEqual(["popup", "popup"]);
  expect([true, false].map((w) => routeFor("off", w))).toEqual(["fallback", "fallback"]);
});

describe("Popup (mode popup)", () => {
  test("the Popup gets the questions and its answer goes back to Claude Code", async () => {
    const result = await ask("b1", [
      { question: "Storage?", options: [{ label: "SQLite" }, { label: "Cloud" }] },
      { question: "Name?", options: [] },
    ]);
    expect(result).toEqual({
      status: "answered",
      answers: { "Storage?": "SQLite", "Name?": "typed" },
    });
    const show = shows()[0]?.show as PopupShow;
    expect(show).toMatchObject({
      type: "show",
      origin: { project: "p", session: "session-" },
      more: 0,
      canWorkspace: false,
    });
    expect(show.questions.map((q) => [q.id, q.question, q.kind])).toEqual([
      ["D-1", "Storage?", "single"],
      ["D-2", "Name?", "text"],
    ]);
    const c = await client();
    expect((await c.call("decision.list", { project })).map((d) => d.status)).toEqual([
      "decided",
      "decided",
    ]);
  });

  test("skip is an answer with a note; fallback, crash, not shown, no Popup → Claude Code's UI", async () => {
    process.env.FAKE_POPUP = "skip";
    const skipped = (await ask("s")) as Extract<AskBatchResult, { status: "answered" }>;
    expect(skipped.status).toBe("answered");
    for (const [fake, batch] of [
      ["fallback", "f"],
      ["crash", "c"],
      ["noshow", "n"],
      ["garbage", "g"],
    ] as const) {
      process.env.FAKE_POPUP = fake;
      expect(await ask(batch)).toEqual({ status: "fallback" });
    }
    popupCommand = undefined;
    expect(await ask("none")).toEqual({ status: "fallback" });
    popupCommand = [join(dir, "missing-popup")];
    expect(await ask("missing")).toEqual({ status: "fallback" });
  });

  test("one window at a time: the second batch waits and is told how many wait", async () => {
    process.env.FAKE_POPUP_DELAY_MS = "300";
    const results = await Promise.all([
      ask("q1"),
      Bun.sleep(50).then(() => ask("q2")),
      Bun.sleep(100).then(() => ask("q3")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["answered", "answered", "answered"]);
    const runs = shows();
    // q2 opens when q1 is done, while q3 still waits behind it.
    expect(runs.map((r) => [r.show.questions[0]?.id, r.show.more])).toEqual([
      ["D-1", 0],
      ["D-2", 1],
      ["D-3", 0],
    ]);
  });

  test("answered in the Workspace meanwhile: the Popup is closed", async () => {
    process.env.FAKE_POPUP = "hang";
    const pending = ask("w");
    await until(() => shows().length === 1);
    const c = await client();
    const [d] = await c.call("decision.list", { project });
    await c.call("decision.answer", {
      project,
      id: "D-1",
      expectedVersion: d?.version ?? 0,
      answer: { selected: ["2"] },
    });
    expect(await pending).toEqual({ status: "answered", answers: { "Storage?": "Cloud" } });
    const pid = shows()[0]?.pid ?? 0;
    await until(() => !alive(pid));
  });

  test("Claude Code withdraws the question (hook disconnects): the Popup is closed", async () => {
    process.env.FAKE_POPUP = "hang";
    const hook = await DwClient.connect({ socketPath });
    void hook
      .call("decision.askBatch", {
        project,
        batchId: "gone",
        questions: [{ question: "Q?", options: [] }],
        route: true,
      })
      .catch(() => {});
    await until(() => shows().length === 1);
    hook.close();
    const pid = shows()[0]?.pid ?? 0;
    await until(() => !alive(pid));
    const c = await client();
    expect((await c.call("decision.list", { project }))[0]?.status).toBe("cancelled");
  });
});

describe("modes", () => {
  test("auto: the Workspace if it watches the project, otherwise the Popup", async () => {
    mode = "auto";
    expect((await ask("no-viewer")).status).toBe("answered");
    expect(shows()).toHaveLength(1);

    const viewer = await client();
    await viewer.call("events.subscribe", { project });
    const pending = ask("viewer");
    await until(async () => (await viewer.call("decision.list", { project })).length === 2);
    expect(shows()).toHaveLength(1); // no second Popup
    const d = (await viewer.call("decision.list", { project }))[1];
    await viewer.call("decision.answer", {
      project,
      id: d?.id ?? "",
      expectedVersion: d?.version ?? 0,
      answer: { selected: ["1"] },
    });
    expect((await pending).status).toBe("answered");
  });

  test("workspace without a Workspace, and off: straight back to Claude Code's UI", async () => {
    mode = "workspace";
    expect(await ask("w")).toEqual({ status: "fallback" });
    mode = "off";
    expect(await ask("o")).toEqual({ status: "fallback" });
    expect(shows()).toHaveLength(0);
  });

  test("toWorkspace: the hook keeps waiting if a Workspace watches; otherwise falls back", async () => {
    process.env.FAKE_POPUP = "toWorkspace";
    expect(await ask("alone")).toEqual({ status: "fallback" });

    mode = "popup";
    const viewer = await client();
    await viewer.call("events.subscribe", { project });
    const pending = ask("moved");
    await until(() => shows().length === 2);
    expect(shows()[1]?.show.canWorkspace).toBe(true);
    await Bun.sleep(100);
    const d = (await viewer.call("decision.list", { project, status: ["ready"] }))[0];
    expect(d?.batchId).toBe("moved");
    await viewer.call("decision.answer", {
      project,
      id: d?.id ?? "",
      expectedVersion: d?.version ?? 0,
      answer: { selected: ["1"] },
    });
    expect((await pending).status).toBe("answered");
  });
});

describe("hook and modes (T-602)", () => {
  const input = (cwd: string) =>
    JSON.stringify({
      session_id: "s",
      cwd,
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_hook",
      tool_input: { questions: [{ question: "Storage?", options: [{ label: "SQLite" }] }] },
    });

  test("off: the hook does nothing, without even connecting", async () => {
    const { runHook } = await import("@dw/hook");
    let started = false;
    const out = await runHook(input(project), {
      socketPath: join(dir, "nobody.sock"),
      mode: () => "off",
      startDaemon: () => {
        started = true;
      },
    });
    expect(out).toBeUndefined();
    expect(started).toBe(false);
  });

  test("workspace: no daemon → pass through; popup: the hook starts the daemon", async () => {
    const { runHook } = await import("@dw/hook");
    const starts: string[] = [];
    const none = join(dir, "nobody.sock");
    const startDaemon = (s: string) => starts.push(s);
    expect(
      await runHook(input(project), { socketPath: none, mode: () => "workspace", startDaemon }),
    ).toBeUndefined();
    expect(starts).toEqual([]);
    // popup: it tries to start one (this fake never comes up, so it still fails open).
    expect(
      await runHook(input(project), { socketPath: none, mode: () => "popup", startDaemon }),
    ).toBeUndefined();
    expect(starts).toEqual([none]);
  });

  test("popup through the real hook path: allow with the Popup's answer", async () => {
    const { runHook } = await import("@dw/hook");
    const out = await runHook(input(project), { socketPath, mode: () => "popup" });
    expect(JSON.parse(out ?? "{}").hookSpecificOutput).toMatchObject({
      permissionDecision: "allow",
      updatedInput: { answers: { "Storage?": "SQLite" } },
    });
  });
});
