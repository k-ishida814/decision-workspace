/**
 * T-312: the whole non-blocking loop with real Claude Code (calls the model twice):
 * Claude queues via MCP → the user answers in the UI → the next prompt carries the answer.
 * Uses `dw install`, so the hook and MCP server are configured exactly as for a user.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";

setDefaultTimeout(300_000);

let dir: string;
let project: string;
let socketPath: string;
let daemon: Daemon;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-e2e-rt-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  socketPath = join(dir, "d.sock");
  daemon = await startDaemon({ socketPath });
  const quiet = { out: () => {}, err: (l: string) => console.error(l) };
  expect(await run(["install", "--project", project], quiet)).toBe(0);
});
afterAll(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function claude(args: string[]): Promise<{ result: string; cost: number }> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      ...args,
      "--model",
      process.env.DW_E2E_MODEL ?? "haiku",
      "--output-format",
      "json",
    ],
    {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DW_SOCKET: socketPath, DW_NOTIFY: "0" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`);
  const json = JSON.parse(stdout);
  return { result: String(json.result), cost: Number(json.total_cost_usd) };
}

test("queue → answer elsewhere → next prompt knows the answer", async () => {
  const session = randomUUID();
  const first = await claude([
    "メモアプリの保存先（選択肢: ローカル / クラウド）をユーザーに決めてもらいたいです。decision_ask ツールで1件登録して、登録した ID だけ答えて終わってください。",
    "--session-id",
    session,
    "--allowedTools",
    "mcp__decision-workspace__decision_ask",
  ]);
  console.log(`[e2e] 1st: $${first.cost.toFixed(3)} ${first.result.slice(0, 80)}`);

  const c = await DwClient.connect({ socketPath });
  const [d] = await c.call("decision.list", { project });
  expect(d?.origin).toBe("plan");
  const cloud = d?.options.find((o) => o.label.includes("クラウド"));
  expect(cloud).toBeDefined();
  await c.call("decision.answer", {
    project,
    id: d?.id ?? "",
    expectedVersion: d?.version ?? 1,
    answer: { selected: [cloud?.id ?? ""] },
    rationale: "複数の端末で使うため",
  });
  c.close();

  const second = await claude([
    "保存先はどうなりましたか？ ツールは使わずに、決まった保存先と理由だけを1行で答えてください。",
    "--resume",
    session,
  ]);
  console.log(`[e2e] 2nd: $${second.cost.toFixed(3)} ${second.result}`);
  expect(second.result).toContain("クラウド");
  expect(second.result).toContain("端末");
});
