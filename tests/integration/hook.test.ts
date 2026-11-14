/**
 * The real hook process against a real daemon (T-201, T-202). Claude Code is simulated by
 * feeding PreToolUse JSON on stdin, exactly as observed in S-01.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCONNECT_REASON, NO_VIEWER_REASON, SKIPPED_ANSWER } from "@dw/core";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import type { DwEvent } from "@dw/protocol";

const HOOK = join(import.meta.dir, "../../apps/hook/src/main.ts");

let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon | undefined;
const clients: DwClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-hook-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true }); // so cwd resolves to this root
  daemon = await startDaemon({ socketPath });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await daemon?.close();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const toolInput = {
  questions: [
    {
      question: "好きな言語は？",
      header: "Lang",
      options: [{ label: "TypeScript" }, { label: "Rust" }],
      multiSelect: false,
    },
    {
      question: "エディタは？",
      options: [{ label: "VS Code" }, { label: "Zed" }],
      multiSelect: true,
    },
  ],
};

function hookInput(toolName = "AskUserQuestion") {
  return JSON.stringify({
    session_id: "s1",
    cwd: join(project, "src"), // a subdirectory: the hook must find the project root
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_use_id: "toolu_1",
    tool_input: toolInput,
  });
}

function spawnHook(input: string) {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DW_SOCKET: socketPath, DW_NOTIFY: "0" },
  });
  const done = (async () => {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  })();
  return { proc, done };
}

/** A UI watching the project, like the TUI. */
async function viewer() {
  const c = await DwClient.connect({ socketPath });
  clients.push(c);
  const events: DwEvent[] = [];
  c.onEvent((e) => events.push(e));
  await c.call("events.subscribe", { project });
  return { c, events };
}

async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

describe("hook ↔ daemon ↔ UI", () => {
  test("answers from the UI come back as allow + updatedInput.answers", async () => {
    const ui = await viewer();
    const { done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    expect(ui.events.map((e) => e.decision.question)).toEqual(["好きな言語は？", "エディタは？"]);

    await ui.c.call("decision.answer", {
      project,
      id: "D-1",
      expectedVersion: 1,
      answer: { selected: ["2"] },
    });
    await ui.c.call("decision.answer", {
      project,
      id: "D-2",
      expectedVersion: 1,
      answer: { selected: ["1", "2"] },
    });

    const { stdout, code } = await done;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          ...toolInput,
          answers: { "好きな言語は？": "Rust", "エディタは？": "VS Code, Zed" },
        },
      },
    });
  });

  test("skip in the UI → allowed, the skipped question carries an instruction, others keep answers", async () => {
    const ui = await viewer();
    const { done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    await ui.c.call("decision.transition", {
      project,
      id: "D-1",
      expectedVersion: 1,
      to: "skipped",
    });
    await ui.c.call("decision.answer", {
      project,
      id: "D-2",
      expectedVersion: 1,
      answer: { selected: ["2"] },
    });
    const out = JSON.parse((await done).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow"); // no "hook error" in Claude Code
    expect(out.hookSpecificOutput.updatedInput.answers).toEqual({
      "好きな言語は？": SKIPPED_ANSWER,
      "エディタは？": "Zed",
    });
  });

  test("cancel (dw cancel) → deny with a reason", async () => {
    const ui = await viewer();
    const { done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    await ui.c.call("decision.transition", {
      project,
      id: "D-1",
      expectedVersion: 1,
      to: "cancelled",
    });
    const out = JSON.parse((await done).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("fallback in the UI → no output (Claude Code asks as usual)", async () => {
    const ui = await viewer();
    const { done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    await ui.c.call("decision.fallback", { project, batchId: "toolu_1" });
    expect(await done).toEqual({ stdout: "", code: 0 });
  });

  test("Claude Code kills the hook (Esc / timeout) → questions are withdrawn", async () => {
    const ui = await viewer();
    const { proc, done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    proc.kill("SIGTERM");
    expect((await done).stdout).toBe("");
    await until(() => ui.events.length === 4);
    expect(ui.events.slice(2).map((e) => e.decision.closedReason)).toEqual([
      DISCONNECT_REASON,
      DISCONNECT_REASON,
    ]);
  });

  test("the last UI closes while waiting → hook hands back to Claude Code", async () => {
    const ui = await viewer();
    const { done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    ui.c.close();
    expect(await done).toEqual({ stdout: "", code: 0 });
    const watcher = await DwClient.connect({ socketPath });
    clients.push(watcher);
    const all = await watcher.call("decision.list", { project });
    expect(all.map((d) => [d.status, d.closedReason])).toEqual([
      ["cancelled", NO_VIEWER_REASON],
      ["cancelled", NO_VIEWER_REASON],
    ]);
  });
});

test("two Claude Code sessions waiting at once get their own answers (T-203, CC-05)", async () => {
  const ui = await viewer();
  const input = (session: string, toolUseId: string, question: string) =>
    JSON.stringify({
      session_id: session,
      cwd: project,
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: { questions: [{ question, options: [{ label: "A" }, { label: "B" }] }] },
    });
  const first = spawnHook(input("s1", "toolu_a", "Q from session 1"));
  const second = spawnHook(input("s2", "toolu_b", "Q from session 2"));
  await until(() => ui.events.length === 2);
  const byQuestion = Object.fromEntries(ui.events.map((e) => [e.decision.question, e.decision]));
  expect(byQuestion["Q from session 1"]?.sessionId).toBe("s1");
  expect(byQuestion["Q from session 2"]?.sessionId).toBe("s2");

  // Answer the second session first.
  const answer = (id: string, option: string) =>
    ui.c.call("decision.answer", {
      project,
      id,
      expectedVersion: 1,
      answer: { selected: [option] },
    });
  await answer(byQuestion["Q from session 2"]?.id ?? "", "2");
  const out2 = JSON.parse((await second.done).stdout);
  expect(out2.hookSpecificOutput.updatedInput.answers).toEqual({ "Q from session 2": "B" });
  await answer(byQuestion["Q from session 1"]?.id ?? "", "1");
  const out1 = JSON.parse((await first.done).stdout);
  expect(out1.hookSpecificOutput.updatedInput.answers).toEqual({ "Q from session 1": "A" });
});

test("a UI opened via a symlink sees questions from the real path (macOS /tmp → /private/tmp)", async () => {
  const link = join(dir, "link");
  symlinkSync(project, link);
  const c = await DwClient.connect({ socketPath });
  clients.push(c);
  const events: DwEvent[] = [];
  c.onEvent((e) => events.push(e));
  await c.call("events.subscribe", { project: link }); // dw tui -p /tmp/...
  const input = JSON.parse(hookInput());
  input.cwd = realpathSync(project); // Claude Code reports the resolved path
  const { proc, done } = spawnHook(JSON.stringify(input));
  await until(() => events.length === 2);
  expect(await c.call("decision.list", { project: link })).toHaveLength(2);
  proc.kill("SIGTERM");
  await done;
});

describe("fail-open (CC-03, NFR-04)", () => {
  test("no UI watching → returns at once with no output and records nothing", async () => {
    const started = Date.now();
    expect(await spawnHook(hookInput()).done).toEqual({ stdout: "", code: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
    const c = await DwClient.connect({ socketPath });
    clients.push(c);
    expect(await c.call("decision.list", { project })).toEqual([]);
  });

  test("no daemon → no output, exit 0", async () => {
    await daemon?.close();
    daemon = undefined;
    expect(await spawnHook(hookInput()).done).toEqual({ stdout: "", code: 0 });
  });

  test("other tools and garbage input → no output, exit 0", async () => {
    await viewer();
    expect(await spawnHook(hookInput("Bash")).done).toEqual({ stdout: "", code: 0 });
    expect(await spawnHook("not json").done).toEqual({ stdout: "", code: 0 });
    expect(
      await spawnHook(JSON.stringify({ tool_name: "AskUserQuestion", tool_input: {} })).done,
    ).toEqual({
      stdout: "",
      code: 0,
    });
  });

  test("daemon dies while waiting → no output, exit 0", async () => {
    const ui = await viewer();
    const { done } = spawnHook(hookInput());
    await until(() => ui.events.length === 2);
    await daemon?.close();
    daemon = undefined;
    expect(await done).toEqual({ stdout: "", code: 0 });
  });
});
