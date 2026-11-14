/** dw stats (T-313, NFR-10): the numbers match agent_runs and the context handed to Claude. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";

const FAKE = join(import.meta.dir, "../../packages/agent-runner/test/fake-claude.ts");
const env = { ...process.env };
let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon;
let c: DwClient;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-stats-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "p");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_OUTPUT = JSON.stringify({
    summary: "s",
    tradeoffs: [],
    recommended: { optionId: "1", reason: "r" },
    newOptions: [],
  });
  daemon = await startDaemon({ socketPath, claudeCommand: ["bun", FAKE] });
  c = await DwClient.connect({ socketPath });
});
afterEach(async () => {
  process.env = { ...env };
  c.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function explore(id: string): Promise<void> {
  const done = new Promise<void>((resolve) =>
    c.onRun((e) => {
      if (e.run.target === id && e.run.status !== "running") resolve();
    }),
  );
  await c.call("events.subscribe", { project });
  await c.call("decision.explore", { project, id });
  await done;
}

test("agent totals, context blocks and decisions add up", async () => {
  const [d1, d2] = await c.call("decision.create", {
    project,
    decisions: [
      { question: "A?", kind: "single", options: [{ id: "1", label: "x" }] },
      { question: "B?", kind: "text" },
    ],
  });
  await explore("D-1");
  process.env.FAKE_MODE = "invalid"; // fails twice (retry): recorded as failed
  await explore("D-2");

  // Session baseline, then two answers delivered in one block, then nothing new.
  await c.call("delivery.take", { project, sessionId: "s1" });
  const fresh = await c.call("decision.get", { project, id: "D-1" });
  await c.call("decision.answer", {
    project,
    id: "D-1",
    expectedVersion: fresh.decision.version,
    answer: { selected: ["1"] },
  });
  await c.call("decision.answer", {
    project,
    id: "D-2",
    expectedVersion: (d2 as { version: number }).version,
    answer: { selected: [], text: "b" },
  });
  const block = await c.call("delivery.take", { project, sessionId: "s1" });
  await c.call("delivery.take", { project, sessionId: "s1" });
  expect(d1?.id).toBe("D-1");

  const stats = await c.call("stats.get", { project });
  const runs = await c.call("agent.list", { project });
  expect(stats.agents.total).toMatchObject({ runs: 2, succeeded: 1, failed: 1 });
  expect(stats.agents.total.costUsd).toBeCloseTo(
    runs.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    6,
  );
  expect(stats.agents.total.inputTokens).toBe(runs.reduce((n, r) => n + (r.inputTokens ?? 0), 0));
  expect(stats.agents.byKind.explorer.runs).toBe(2);
  expect(stats.agents.byKind.planner.runs).toBe(0);
  expect(stats.context).toEqual({
    sessions: 1,
    blocks: 1,
    decisions: 2,
    chars: block.text?.length ?? -1,
    maxChars: block.text?.length ?? -1,
  });
  expect(stats.decisions).toMatchObject({
    total: 2,
    byStatus: { decided: 2 },
    byOrigin: { manual: 2 },
    answers: 2,
    changed: 0,
  });

  const out: string[] = [];
  const code = await run(
    ["stats", "--socket", socketPath, "--project", project],
    { out: (l) => out.push(l), err: () => {} },
    { autoStart: () => {} },
  );
  expect(code).toBe(0);
  const text = out.join("\n");
  expect(text).toContain("  explorer    2 runs  1 ok / 1 failed / 0 cancelled");
  expect(text).toContain("1 sessions, 1 blocks, 2 decisions");
  expect(text).toContain("2 total: decided 2");
});
