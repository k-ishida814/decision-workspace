import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { type Daemon, startDaemon } from "@dw/daemon";

const FAKE = join(import.meta.dir, "../../packages/agent-runner/test/fake-claude.ts");
const env = { ...process.env };
let dir: string;
let socket: string;
let project: string;
let daemon: Daemon;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-cli-x-"));
  socket = join(dir, "d.sock");
  project = join(dir, "p");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_OUTPUT = JSON.stringify({
    summary: "同期の要否が決め手。",
    tradeoffs: [{ optionId: "1", pros: ["速い"], cons: ["共有できない"] }],
    recommended: { optionId: "1", reason: "オフライン優先" },
    newOptions: [{ label: "ハイブリッド", description: "ローカル＋バックアップ" }],
  });
  daemon = await startDaemon({ socketPath: socket, claudeCommand: ["bun", FAKE] });
});
afterEach(async () => {
  process.env = { ...env };
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function dw(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    [...argv, "--socket", socket, "--project", project],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { autoStart: () => {} },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("dw explore waits for the Deep Dive and shows the result; show keeps it", async () => {
  await dw("add", "保存先は？", "-o", "ローカル", "-o", "クラウド");
  const r = await dw("explore", "D-1");
  expect(r.code).toBe(0);
  expect(r.err).toContain("Deep Dive on D-1 (R-1");
  expect(r.out).toContain("1. ローカル *recommended");
  expect(r.out).toContain("x1. ハイブリッド (proposed) — ローカル＋バックアップ");
  expect(r.out).toContain("recommended: ローカル — オフライン優先");
  expect(r.out).toContain("deep dive (R-1): 同期の要否が決め手。");
  expect(r.out).toContain("ローカル: pros 速い; cons 共有できない");
  expect(r.out).toMatch(/\(R-1: [\d.]+s, USD 0\.010\)/);
  expect((await dw("show", "D-1")).out).toContain("deep dive (R-1)");
  // A proposed option can be chosen like any other.
  expect((await dw("answer", "D-1", "ハイブリッド")).out).toBe("D-1 decided: ハイブリッド");
});

test("--detach returns at once; failures exit 1 with the reason", async () => {
  await dw("add", "保存先は？", "-o", "ローカル");
  expect((await dw("explore", "D-1", "--detach")).out).toContain("R-1 started");
  await Bun.sleep(300);
  process.env.FAKE_MODE = "crash";
  const failed = await dw("explore", "D-1");
  expect(failed.code).toBe(1);
  expect(failed.out).toContain("R-2 failed: claude exited with code 3: boom: not logged in");
});
