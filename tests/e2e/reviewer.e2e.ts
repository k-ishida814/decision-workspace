/** T-310: a real Reviewer run (calls the model) on answers that clearly conflict. */
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
  dir = mkdtempSync(join(tmpdir(), "dw-e2e-review-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# Notes app\n\nNotes app for macOS.\n");
  const socketPath = join(dir, "d.sock");
  daemon = await startDaemon({
    socketPath,
    config: () => ({
      agents: { ...DEFAULT_CONFIG.agents, model: process.env.DW_E2E_MODEL ?? "haiku" },
    }),
  });
  c = await DwClient.connect({ socketPath });
  await c.call("events.subscribe", { project });
  const created = await c.call("decision.create", {
    project,
    decisions: [
      {
        title: "ネットワーク",
        question: "アプリはネットワークに接続しますか？",
        kind: "single",
        options: [
          { id: "1", label: "完全オフライン（通信しない）" },
          { id: "2", label: "オンライン" },
        ],
      },
      {
        title: "同期",
        question: "複数端末でメモをどう同期しますか？",
        kind: "single",
        options: [
          { id: "1", label: "自前サーバーとリアルタイム同期" },
          { id: "2", label: "同期しない" },
        ],
      },
    ],
  });
  for (const d of created) {
    await c.call("decision.answer", {
      project,
      id: d.id,
      expectedVersion: d.version,
      answer: { selected: ["1"] },
    });
  }
});
afterAll(async () => {
  c?.close();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Reviewer with the real model: finds the conflict", async () => {
  const finished = new Promise<RunEvent>((resolve) =>
    c.onRun((e) => {
      if (e.run.status !== "running") resolve(e);
    }),
  );
  await c.call("review.start", { project });
  const { run } = await finished;
  console.log(
    `[e2e] reviewer ${run.status} ${((run.durationMs ?? 0) / 1000).toFixed(1)}s $${(run.costUsd ?? 0).toFixed(3)} ${run.error ?? ""}`,
  );
  expect(run.status).toBe("succeeded");
  const proposals = await c.call("review.list", { project });
  for (const p of proposals) {
    console.log(`${p.id} [${p.kind}] ${p.title} ${p.decisionIds.join(",")}: ${p.reason}`);
  }
  // The two answers cannot both hold: some proposal must reopen them.
  expect(proposals.some((p) => p.kind !== "add" && p.decisionIds.length > 0)).toBe(true);
});
