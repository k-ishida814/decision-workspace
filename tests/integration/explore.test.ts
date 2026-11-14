/** Deep Dive through the daemon with a fake claude (T-308). No model is called. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient, type RpcCallError } from "@dw/ipc-client";
import { DEFAULT_CONFIG, type DwEvent, ErrorCode, type RunEvent } from "@dw/protocol";

const FAKE = join(import.meta.dir, "../../packages/agent-runner/test/fake-claude.ts");
const env = { ...process.env };

let dir: string;
let project: string;
let daemon: Daemon | undefined;
let c: DwClient;
let runs: RunEvent[];
let events: DwEvent[];

const output = {
  summary: "決め手は UI ロジックの共有と将来の Windows 対応。",
  tradeoffs: [
    { optionId: "tauri", pros: ["reducer を共有"], cons: ["Rust が要る"] },
    { optionId: "swiftui", pros: ["フォーカス制御"], cons: ["macOS のみ"] },
  ],
  recommended: { optionId: "tauri", reason: "共有と移植性" },
  newOptions: [{ label: "Wails", description: "Go 製" }],
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-explore-"));
  project = join(dir, "p");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_OUTPUT = JSON.stringify(output);
  process.env.FAKE_ARGS_FILE = join(dir, "args.json");
  const socketPath = join(dir, "d.sock");
  daemon = await startDaemon({
    socketPath,
    claudeCommand: ["bun", FAKE],
    config: () => ({ agents: { ...DEFAULT_CONFIG.agents, model: "haiku" } }),
  });
  c = await DwClient.connect({ socketPath });
  runs = [];
  events = [];
  c.onRun((e) => runs.push(e));
  c.onEvent((e) => events.push(e));
  await c.call("events.subscribe", { project });
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
});

afterEach(async () => {
  process.env = { ...env };
  c.close();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await Bun.sleep(10);
  }
}

test("explore returns at once, then the result is merged and announced", async () => {
  const started = await c.call("decision.explore", { project, id: "D-1" });
  expect(started).toMatchObject({
    id: "R-1",
    kind: "explorer",
    target: "D-1",
    model: "haiku",
    status: "running",
  });

  await until(() => runs.some((r) => r.run.status !== "running"));
  expect(runs.map((r) => r.run.status)).toEqual(["running", "succeeded"]);
  expect(runs[1]?.run).toMatchObject({ costUsd: 0.01, inputTokens: 150, outputTokens: 20 });

  const { decision, explorations } = await c.call("decision.get", { project, id: "D-1" });
  expect(decision.status).toBe("ready"); // status untouched by a Deep Dive
  expect(
    decision.options.map((o) => [o.id, o.label, o.recommended ?? false, o.source ?? ""]),
  ).toEqual([
    ["tauri", "Tauri 2", true, ""],
    ["swiftui", "SwiftUI", false, ""],
    ["x1", "Wails", false, "explorer"],
  ]);
  expect(explorations).toHaveLength(1);
  expect(explorations[0]).toMatchObject({ runId: "R-1", summary: output.summary });
  expect(events.some((e) => e.type === "decision.updated" && e.decision.options.length === 3)).toBe(
    true,
  );

  // The transcript stays next to the project's database, never in the response.
  const transcript = runs[1]?.run.transcriptPath ?? "";
  expect(transcript).toContain(join(".decision-workspace", "runs", "R-1.jsonl"));
  expect(existsSync(transcript)).toBe(true);

  // The prompt carries the decision as data.
  const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
  expect(args[args.indexOf("-p") + 1]).toContain("<data>\nDecision D-1: Popup の技術は？");
  expect(args[args.indexOf("--model") + 1]).toBe("haiku");
});

test("one Deep Dive per decision at a time; closed decisions are refused", async () => {
  process.env.FAKE_DELAY_MS = "500";
  await c.call("decision.explore", { project, id: "D-1" });
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e: RpcCallError) => e.code,
    );
  expect(await code(c.call("decision.explore", { project, id: "D-1" }))).toBe(ErrorCode.AgentBusy);
  await until(() => runs.some((r) => r.run.status === "succeeded"));

  await c.call("decision.answer", {
    project,
    id: "D-1",
    expectedVersion: 2,
    answer: { selected: ["tauri"] },
  });
  expect(await code(c.call("decision.explore", { project, id: "D-1" }))).toBe(
    ErrorCode.InvalidTransition,
  );
  expect(await code(c.call("decision.explore", { project, id: "D-9" }))).toBe(ErrorCode.NotFound);
});

test("cancel stops the agent and records it", async () => {
  process.env.FAKE_MODE = "hang";
  const run = await c.call("decision.explore", { project, id: "D-1" });
  await Bun.sleep(100);
  await c.call("agent.cancel", { project, runId: run.id });
  await until(() => runs.some((r) => r.run.status === "cancelled"));
  const { decision, explorations } = await c.call("decision.get", { project, id: "D-1" });
  expect(decision.options).toHaveLength(2);
  expect(explorations).toEqual([]);
  expect((await c.call("agent.list", { project, target: "D-1" }))[0]?.status).toBe("cancelled");
});

test("a failed agent leaves the decision as it was and says why", async () => {
  process.env.FAKE_MODE = "invalid";
  await c.call("decision.explore", { project, id: "D-1" });
  await until(() => runs.some((r) => r.run.status === "failed"));
  expect(runs.at(-1)?.run.error).toContain("does not match the schema");
  expect((await c.call("decision.get", { project, id: "D-1" })).decision.version).toBe(1);
});

test("answering while the Deep Dive runs is fine; the result is kept as history only", async () => {
  process.env.FAKE_DELAY_MS = "300";
  await c.call("decision.explore", { project, id: "D-1" });
  await c.call("decision.answer", {
    project,
    id: "D-1",
    expectedVersion: 1,
    answer: { selected: ["swiftui"] },
  });
  await until(() => runs.some((r) => r.run.status === "succeeded"));
  const { decision, explorations } = await c.call("decision.get", { project, id: "D-1" });
  expect(decision.options).toHaveLength(2);
  expect(explorations).toHaveLength(1);
});

test("stopping the daemon cancels running agents and records it", async () => {
  process.env.FAKE_MODE = "hang";
  await c.call("decision.explore", { project, id: "D-1" });
  await Bun.sleep(100);
  await daemon?.close();
  daemon = undefined;
  const { Store, dbPathFor } = await import("@dw/storage");
  const s = new Store(dbPathFor(project));
  expect(s.runs()[0]?.status).toBe("cancelled");
  s.close();
});
