/** T-309: a real Planner run (calls the model). */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overviewText } from "@dw/core";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import { DEFAULT_CONFIG, type RunEvent } from "@dw/protocol";

setDefaultTimeout(240_000);
let dir: string;
let project: string;
let daemon: Daemon;
let c: DwClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-e2e-plan-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(
    join(project, "README.md"),
    "# Notes app\n\nOffline-first notes app for macOS. Single user today.\n",
  );
  const socketPath = join(dir, "d.sock");
  daemon = await startDaemon({
    socketPath,
    config: () => ({
      agents: { ...DEFAULT_CONFIG.agents, model: process.env.DW_E2E_MODEL ?? "haiku" },
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

test("Planner with the real model: a usable plan with dependencies", async () => {
  const finished = new Promise<RunEvent>((resolve) =>
    c.onRun((e) => {
      if (e.run.status !== "running") resolve(e);
    }),
  );
  await c.call("plan.generate", { project, request: "複数の Mac でメモを同期できるようにしたい" });
  const { run } = await finished;
  console.log(
    `[e2e] planner ${run.status} ${((run.durationMs ?? 0) / 1000).toFixed(1)}s $${(run.costUsd ?? 0).toFixed(3)} ${run.error ?? ""}`,
  );
  expect(run.status).toBe("succeeded");
  const all = await c.call("decision.list", { project });
  console.log(overviewText(all, await c.call("plan.list", { project })));
  expect(all.length).toBeGreaterThanOrEqual(2);
  expect(all.some((d) => d.status === "ready")).toBe(true);
  expect(all.some((d) => d.dependsOn.length > 0)).toBe(true);
});
