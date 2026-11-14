/**
 * TUI against a real daemon (T-107–T-109). The "hook" side is a plain client calling
 * decision.askBatch, so this covers the whole path except Claude Code itself.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import { App, daemonBackend } from "@dw/tui";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";

let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon;
let ui: TestRendererSetup | undefined;
const clients: DwClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-tui-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "project");
  daemon = await startDaemon({ socketPath });
});

afterEach(async () => {
  await ui?.dispose();
  ui = undefined;
  for (const c of clients.splice(0)) c.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function client(): Promise<DwClient> {
  const c = await DwClient.connect({ socketPath });
  clients.push(c);
  return c;
}

async function mount(): Promise<TestRendererSetup> {
  const backend = daemonBackend(await client(), project);
  ui = await testRender(<App backend={backend} />, { width: 90, height: 28 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  return ui;
}

/** Render in real time until the frame matches (waitForFrame does not let time pass). */
async function frame(pred: (f: string) => boolean, timeoutMs = 3000): Promise<string> {
  const s = ui as TestRendererSetup;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    await s.renderOnce();
    last = s.captureCharFrame();
    if (pred(last)) return last;
    await Bun.sleep(10);
  }
  throw new Error(`frame did not match. last frame:\n${last}`);
}

const questions = [
  {
    question: "好きな言語は？",
    header: "Lang",
    options: [{ label: "TypeScript" }, { label: "Rust" }],
  },
  {
    question: "使うエディタは？",
    header: "Editor",
    multiSelect: true,
    options: [{ label: "VS Code" }, { label: "Neovim" }, { label: "Zed" }],
  },
];

test("an AskUserQuestion batch is answered one question at a time in the TUI", async () => {
  const s = await mount();
  await frame((f) => f.includes("Waiting for Claude Code"));

  const hook = await client();
  const result = hook.call("decision.askBatch", {
    project,
    batchId: "toolu_1",
    sessionId: "s1",
    questions,
  });

  const first = await frame((f) => f.includes("好きな言語は？"));
  expect(first).toContain("D-1 · Lang 1/2");
  expect(first).toContain("2 new questions");
  expect(first).not.toContain("使うエディタは？"); // one at a time

  s.mockInput.pressKey("2");
  s.mockInput.pressEnter();
  await frame((f) => f.includes("使うエディタは？") && f.includes("D-2 · Editor 2/2"));

  s.mockInput.pressKey("1");
  s.mockInput.pressKey("3");
  await frame((f) => f.includes("[x] 1. VS Code") && f.includes("[x] 3. Zed"));
  s.mockInput.pressEnter();

  expect(await result).toEqual({
    status: "answered",
    answers: { "好きな言語は？": "Rust", "使うエディタは？": "VS Code, Zed" },
  });
  await frame((f) => f.includes("No open questions"));
});

test("Esc in Claude Code (hook disconnects) is shown in the TUI", async () => {
  await mount();
  const hook = await client();
  hook.call("decision.askBatch", { project, batchId: "toolu_1", questions }).catch(() => {});
  await frame((f) => f.includes("好きな言語は？"));
  hook.close();
  const f = await frame((x) => x.includes("Claude Code withdrew the question"));
  expect(f).toContain("No open questions");
});

test("rationale, history and revisit", async () => {
  const s = await mount();
  const cli = await client();
  await cli.call("decision.create", {
    project,
    decisions: [
      {
        question: "保存先は？",
        title: "DB",
        kind: "single",
        options: [
          { id: "1", label: "SQLite" },
          { id: "2", label: "Postgres" },
        ],
      },
    ],
  });
  await frame((f) => f.includes("保存先は？"));

  s.mockInput.pressKey("w");
  await frame((f) => f.includes("Why you decided"));
  await s.mockInput.typeText("オフライン");
  s.mockInput.pressEnter();
  await frame((f) => f.includes("Why: オフライン"));
  s.mockInput.pressEnter();
  await frame((f) => f.includes("No open questions"));

  s.mockInput.pressTab();
  s.mockInput.pressTab();
  const history = await frame((f) => f.includes("[History]") && f.includes("→ SQLite"));
  expect(history).toContain("(why: オフライン)");

  s.mockInput.pressKey("u");
  await frame((f) => f.includes("[Current]") && f.includes("保存先は？"));
  s.mockInput.pressKey("2");
  s.mockInput.pressEnter();
  s.mockInput.pressTab();
  s.mockInput.pressTab();
  await frame((f) => f.includes("→ Postgres") && f.includes("revision 2"));
});

test("a conflicting answer from another screen is reported, not lost", async () => {
  const s = await mount();
  const other = await client();
  const [d] = await other.call("decision.create", {
    project,
    decisions: [
      {
        question: "Q?",
        kind: "single",
        options: [
          { id: "1", label: "A" },
          { id: "2", label: "B" },
        ],
      },
    ],
  });
  await frame((f) => f.includes("Q?"));
  await other.call("decision.answer", {
    project,
    id: "D-1",
    expectedVersion: d?.version ?? 1,
    answer: { selected: ["2"] },
  });
  await frame((f) => f.includes("D-1 was answered elsewhere"));
  s.mockInput.pressEnter(); // nothing to answer any more
  await frame((f) => f.includes("No open questions"));
});

test("graph in the TUI: queue tree, prerequisites in Current, diff in History (T-305)", async () => {
  const s = await mount();
  const cli = await client();
  await cli.call("decision.create", {
    project,
    decisions: [
      {
        key: "where",
        title: "保存先",
        question: "保存先は？",
        kind: "single",
        planId: "P-1",
        options: [
          { id: "local", label: "ローカル" },
          { id: "cloud", label: "クラウド" },
        ],
      },
      {
        key: "sync",
        title: "同期",
        question: "同期方式は？",
        kind: "single",
        planId: "P-1",
        options: [
          { id: "crdt", label: "CRDT" },
          { id: "lww", label: "後勝ち" },
        ],
        dependsOn: [{ ref: "where", whenOptions: ["cloud"] }],
      },
    ],
  });

  // Queue: the dependent decision is nested and marked as waiting.
  await frame((f) => f.includes("保存先は？"));
  s.mockInput.pressTab();
  const queue = await frame((f) => f.includes("[Queue]") && f.includes("同期方式は？"));
  expect(queue).toContain("P-1");
  expect(queue).toMatch(/└ D-2 +\[同期\] 同期方式は？ +\(waiting for D-1\)/);

  // Current shows only D-1; after answering cloud, D-2 appears with its prerequisite.
  // Queue → History → Graph → Current.
  for (let i = 0; i < 3; i++) s.mockInput.pressTab();
  await frame((f) => f.includes("[Current]") && f.includes("保存先は？"));
  s.mockInput.pressKey("2");
  s.mockInput.pressEnter();
  const second = await frame((f) => f.includes("同期方式は？") && f.includes("After:"));
  expect(second).toContain("After: D-1 保存先 = クラウド (when クラウド)");
  s.mockInput.pressKey("1");
  s.mockInput.pressEnter();
  await frame((f) => f.includes("No open questions"));

  // Redo D-1 from History: D-2 comes back for re-confirmation with its old answer.
  s.mockInput.pressTab();
  s.mockInput.pressTab();
  await frame((f) => f.includes("[History]") && /› D-2/.test(f)); // newest first; nothing depends on it
  s.mockInput.pressKey("j");
  const history = await frame((f) => /› D-1/.test(f) && f.includes("affects:"));
  expect(history).toMatch(/affects: D-2 decided/);
  s.mockInput.pressKey("u");
  await frame((f) => f.includes("[Current]") && f.includes("保存先は？"));
  s.mockInput.pressKey("2");
  s.mockInput.pressEnter(); // same answer again
  const recheck = await frame((f) => f.includes("同期方式は？"));
  expect(recheck).toContain("Answer again (was: CRDT)");
  s.mockInput.pressKey("2");
  s.mockInput.pressEnter();
  s.mockInput.pressTab();
  s.mockInput.pressTab();
  const after = await frame((f) => f.includes("[History]") && f.includes("was (revision 1): CRDT"));
  expect(after).toContain("→ 後勝ち");
});

test("Graph tab shows decided and skipped branches of a plan at once (T-314, DG-07)", async () => {
  const s = await mount();
  const cli = await client();
  await cli.call("plan.create", {
    project,
    request: "同期機能の設計",
    source: "claude",
    decisions: [
      {
        key: "where",
        title: "保存先",
        question: "保存先は？",
        kind: "single",
        options: [
          { id: "1", label: "ローカル" },
          { id: "2", label: "クラウド" },
        ],
      },
      {
        key: "sync",
        title: "同期方式",
        question: "同期方式は？",
        kind: "text",
        dependsOn: [{ ref: "where", whenOptions: ["2"] }],
      },
      { key: "db", title: "DB", question: "DB は？", kind: "text", dependsOn: [{ ref: "where" }] },
    ],
  });
  await frame((f) => f.includes("保存先は？"));
  s.mockInput.pressKey("1");
  s.mockInput.pressEnter(); // ローカル → 同期方式 is skipped, DB opens
  await frame((f) => f.includes("DB は？"));

  for (let i = 0; i < 3; i++) s.mockInput.pressTab();
  const graph = await frame((f) => f.includes("[Graph]") && f.includes("P-1 同期機能の設計"));
  expect(graph).toContain("└─ D-1 [decided] 保存先 → ローカル");
  expect(graph).toContain("├─ D-2 [skipped] 同期方式  (when クラウド; skipped: condition not met)");
  expect(graph).toContain("└─ D-3 [open] DB");

  // Enter on the open one jumps to Current.
  s.mockInput.pressKey("j");
  s.mockInput.pressKey("j");
  s.mockInput.pressEnter();
  await frame((f) => f.includes("[Current]") && f.includes("DB は？"));
});
