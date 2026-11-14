/** Deep Dive from the TUI against a real daemon and a fake claude (T-308). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import { App, daemonBackend } from "@dw/tui";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";

const FAKE = join(import.meta.dir, "../../packages/agent-runner/test/fake-claude.ts");
const env = { ...process.env };
let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon;
let ui: TestRendererSetup | undefined;
const clients: DwClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-tui-x-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "p");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_DELAY_MS = "400";
  process.env.FAKE_OUTPUT = JSON.stringify({
    summary: "決め手は共有と移植性。",
    tradeoffs: [{ optionId: "tauri", pros: ["reducer を共有"], cons: ["Rust が要る"] }],
    recommended: { optionId: "tauri", reason: "UI ロジックを共有できる" },
    newOptions: [{ label: "Wails", description: "Go 製" }],
  });
  daemon = await startDaemon({ socketPath, claudeCommand: ["bun", FAKE] });
});

afterEach(async () => {
  process.env = { ...env };
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
  ui = await testRender(<App backend={daemonBackend(await client(), project)} />, {
    width: 100,
    height: 32,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  return ui;
}

async function frame(pred: (f: string) => boolean, timeoutMs = 4000): Promise<string> {
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

async function addQuestion(origin: "ask" | "manual" = "manual") {
  const c = await client();
  if (origin === "ask") {
    void c
      .call("decision.askBatch", {
        project,
        batchId: "toolu_1",
        questions: [
          { question: "Popup の技術は？", options: [{ label: "Tauri 2" }, { label: "SwiftUI" }] },
        ],
      })
      .catch(() => {});
    return;
  }
  await c.call("decision.create", {
    project,
    decisions: [
      {
        question: "Popup の技術は？",
        kind: "single",
        options: [
          { id: "tauri", label: "Tauri 2" },
          { id: "swiftui", label: "SwiftUI" },
        ],
      },
    ],
  });
}

test("d runs a Deep Dive and the result appears in Current", async () => {
  const s = await mount();
  await addQuestion();
  await frame((f) => f.includes("Popup の技術は？"));
  s.mockInput.pressKey("d");
  await frame((f) => f.includes("Deep Dive running…") && f.includes("d to cancel"));
  const done = await frame((f) => f.includes("Deep Dive: 決め手は共有と移植性。"));
  expect(done).toContain("1. Tauri 2 ★ recommended");
  expect(done).toContain("＋ reducer を共有　－ Rust が要る");
  expect(done).toContain("3. Wails (from Deep Dive)");
  expect(done).toContain("Recommended: Tauri 2 — UI ロジックを共有できる");
  expect(done).not.toContain("Deep Dive running…");
  // The proposed option can be picked right away.
  s.mockInput.pressKey("3");
  s.mockInput.pressEnter();
  await frame((f) => f.includes("No open questions"));
});

test("d again cancels; a waiting Claude Code is shown for AskUserQuestion questions", async () => {
  process.env.FAKE_MODE = "hang";
  const s = await mount();
  await addQuestion("ask");
  await frame((f) => f.includes("Popup の技術は？"));
  s.mockInput.pressKey("d");
  const running = await frame((f) => f.includes("Deep Dive running…"));
  expect(running).toContain("Claude Code is waiting");
  expect(running).toContain("gives up after 10 minutes");
  s.mockInput.pressKey("d");
  await frame((f) => f.includes("Deep Dive of D-1 cancelled") && !f.includes("Deep Dive running…"));
});
