/**
 * T-206: end-to-end with the real Claude Code CLI.
 *
 *   bun run e2e
 *
 * Not part of `bun test`: it calls the model (uses your Claude account) and needs `claude` on
 * PATH. A scripted "UI" answers whatever the hook sends, so no human is needed.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import type { Decision } from "@dw/protocol";

setDefaultTimeout(180_000);

const MODEL = process.env.DW_E2E_MODEL ?? "haiku";

let dir: string;
let project: string;
let socketPath: string;
let daemon: Daemon;
let ui: DwClient;
const seen: Decision[] = [];

/** How the scripted user answers: pick "Rust" if offered, otherwise skip. */
let policy: (d: Decision) => "answer" | "skip" = () => "answer";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-e2e-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  socketPath = join(dir, "d.sock");
  daemon = await startDaemon({ socketPath });

  const quiet = { out: () => {}, err: (l: string) => console.error(l) };
  expect(await run(["install", "--project", project], quiet)).toBe(0);

  ui = await DwClient.connect({ socketPath });
  await ui.call("events.subscribe", { project });
  ui.onEvent(async (e) => {
    if (e.type !== "decision.created") return;
    const d = e.decision;
    seen.push(d);
    if (policy(d) === "skip") {
      await ui.call("decision.transition", {
        project,
        id: d.id,
        expectedVersion: d.version,
        to: "skipped",
      });
      return;
    }
    const pick = d.options.find((o) => o.label === "Rust") ?? d.options[0];
    await ui.call("decision.answer", {
      project,
      id: d.id,
      expectedVersion: d.version,
      answer: pick ? { selected: [pick.id] } : { selected: [], text: "Rust" },
    });
  });
});

afterAll(async () => {
  ui?.close();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Requests that reached the stub permission host (should never include AskUserQuestion). */
function permissionRequests(): string[] {
  const file = join(dir, "permission.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

async function claude(prompt: string): Promise<{ result: string; code: number; stderr: string }> {
  // -p only offers AskUserQuestion when a permission host exists; see permission-stub.ts.
  const mcpConfig = {
    mcpServers: { dwperm: { command: "bun", args: [join(import.meta.dir, "permission-stub.ts")] } },
  };
  const args = [
    "claude",
    "-p",
    prompt,
    "--model",
    MODEL,
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--permission-prompt-tool",
    "mcp__dwperm__deny",
  ];
  const proc = Bun.spawn(args, {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DW_SOCKET: socketPath,
      DW_NOTIFY: "0",
      DW_E2E_PERMISSION_LOG: join(dir, "permission.log"),
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let result = stdout;
  try {
    result = JSON.parse(stdout).result ?? stdout;
  } catch {}
  return { result, code, stderr };
}

const ASK =
  "AskUserQuestion ツールを使って「好きなプログラミング言語は？」を TypeScript / Rust / Go の3択（単一選択）で1問だけ聞いてください。" +
  "回答を受け取ったら、受け取った回答の文字列だけをそのまま1行で出力してください。";

test("claude -p: AskUserQuestion goes through the hook, the UI answers, Claude receives it", async () => {
  policy = () => "answer";
  const { result, code, stderr } = await claude(ASK);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(seen.map((d) => d.question)).toContain("好きなプログラミング言語は？");
  expect(result).toContain("Rust");
  expect(permissionRequests()).not.toContain("AskUserQuestion"); // the hook answered, not the host
});

test("claude -p: a skip reaches Claude as a note, not an error", async () => {
  policy = () => "skip";
  const before = seen.length;
  const { result, code } = await claude(ASK);
  expect(code).toBe(0);
  expect(seen.length).toBeGreaterThan(before);
  expect(result).not.toContain("hook error");
  console.log(`[e2e] Claude after skip: ${result.slice(0, 200)}`);
});
