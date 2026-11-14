/**
 * T-308: a real Deep Dive with the user's Claude Code (calls the model).
 *   bun run e2e
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import { DEFAULT_CONFIG, type RunEvent } from "@dw/protocol";

setDefaultTimeout(240_000);

let dir: string;
let project: string;
let daemon: Daemon;
let c: DwClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-e2e-x-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(
    join(project, "README.md"),
    "# Notes app\n\nA small offline-first notes app for macOS. Single user. Data must survive app updates.\n",
  );
  const socketPath = join(dir, "d.sock");
  daemon = await startDaemon({
    socketPath,
    config: () => ({
      agents: {
        ...DEFAULT_CONFIG.agents,
        model: process.env.DW_E2E_MODEL ?? "haiku",
        maxBudgetUsd: 0.5,
      },
    }),
  });
  c = await DwClient.connect({ socketPath });
  await c.call("events.subscribe", { project });
});

afterAll(async () => {
  c?.close();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Deep Dive with the real model: validated result merged into the decision", async () => {
  await c.call("decision.create", {
    project,
    decisions: [
      {
        title: "保存形式",
        question: "メモの保存形式はどれにする？",
        kind: "single",
        options: [
          { id: "sqlite", label: "SQLite" },
          { id: "json", label: "JSON ファイル" },
        ],
      },
    ],
  });
  const finished = new Promise<RunEvent>((resolve) => {
    c.onRun((e) => {
      if (e.run.status !== "running") resolve(e);
    });
  });
  await c.call("decision.explore", { project, id: "D-1" });
  const { run } = await finished;
  console.log(
    `[e2e] explorer ${run.status} in ${((run.durationMs ?? 0) / 1000).toFixed(1)}s, $${(run.costUsd ?? 0).toFixed(3)} ${run.error ?? ""}`,
  );
  expect(run.status).toBe("succeeded");

  const { decision, explorations } = await c.call("decision.get", { project, id: "D-1" });
  expect(explorations).toHaveLength(1);
  expect(explorations[0]?.summary.length).toBeGreaterThan(10);
  expect(decision.options.filter((o) => o.recommended)).toHaveLength(1);
  expect(decision.options.slice(0, 2).map((o) => o.label)).toEqual(["SQLite", "JSON ファイル"]);
  console.log(`[e2e] summary: ${explorations[0]?.summary}`);
  console.log(
    `[e2e] options: ${decision.options.map((o) => `${o.label}${o.recommended ? "★" : ""}`).join(", ")}`,
  );
});
