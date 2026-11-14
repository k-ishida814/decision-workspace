/** T-311: real Claude Code queues decisions through our MCP server (calls the model). */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";

setDefaultTimeout(240_000);

let dir: string;
let project: string;
let socketPath: string;
let daemon: Daemon;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-e2e-mcp-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  socketPath = join(dir, "d.sock");
  daemon = await startDaemon({ socketPath });
});
afterAll(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("claude -p uses decision_ask to queue dependent decisions and does not wait", async () => {
  const mcpConfig = {
    mcpServers: {
      "decision-workspace": {
        command: "bun",
        args: [join(import.meta.dir, "../../apps/mcp/src/main.ts")],
        env: { DW_SOCKET: socketPath, CLAUDE_PROJECT_DIR: project },
      },
    },
  };
  const prompt =
    "ノートアプリの同期機能について、ユーザーが決めるべき論点を decision_ask ツールで3つ登録してください。" +
    "1つ目は「保存先」（ローカル / クラウド）。2つ目は保存先がクラウドのときだけ聞く「同期方式」。3つ目は保存先に依存する「暗号化」。" +
    "登録したら、割り当てられた ID を1行で答えて終わってください。";
  const started = Date.now();
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      prompt,
      "--model",
      process.env.DW_E2E_MODEL ?? "haiku",
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--allowedTools",
      "mcp__decision-workspace__decision_ask",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--no-session-persistence",
    ],
    { cwd: project, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = JSON.parse(stdout);
  console.log(
    `[e2e] mcp: ${((Date.now() - started) / 1000).toFixed(1)}s, $${Number(result.total_cost_usd).toFixed(3)}: ${String(result.result).slice(0, 160)}`,
  );
  expect(code).toBe(0);

  const c = await DwClient.connect({ socketPath });
  const all = await c.call("decision.list", { project });
  c.close();
  console.log(
    `[e2e] queued: ${all.map((d) => `${d.id}[${d.status}] ${d.question} deps=${JSON.stringify(d.dependsOn)}`).join(" | ")}`,
  );
  expect(all.length).toBe(3);
  expect(all.every((d) => d.origin === "plan" && d.planId === "P-1")).toBe(true);
  expect(all.filter((d) => d.status === "ready")).toHaveLength(1); // only the root can be answered now
  expect(all.some((d) => d.dependsOn.some((dep) => dep.whenOptions))).toBe(true); // the conditional one
});
