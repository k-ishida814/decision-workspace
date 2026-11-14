import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { loadConfig } from "@dw/ipc-client";
import { DEFAULT_CONFIG } from "@dw/protocol";

let dir: string;
let file: string;
const saved = process.env.DW_CONFIG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dw-config-"));
  file = join(dir, "config.json");
  process.env.DW_CONFIG = file;
});
afterEach(() => {
  if (saved === undefined) delete process.env.DW_CONFIG;
  else process.env.DW_CONFIG = saved;
  rmSync(dir, { recursive: true, force: true });
});

async function dw(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("no file means the defaults from S-03 (CF-01)", async () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.agents).toEqual({
    model: "sonnet",
    maxBudgetUsd: 0.5,
    maxTurns: 12,
    concurrency: 2,
  });
  expect((await dw("config", "get", "agents.maxTurns")).out).toBe("12");
  expect(existsSync(file)).toBe(false);
});

test("set writes only the given key and get reads it back", async () => {
  expect((await dw("config", "set", "agents.model", "haiku")).code).toBe(0);
  expect((await dw("config", "set", "agents.maxBudgetUsd", "0.25")).code).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    agents: { model: "haiku", maxBudgetUsd: 0.25 },
  });
  expect(loadConfig().agents).toEqual({
    model: "haiku",
    maxBudgetUsd: 0.25,
    maxTurns: 12,
    concurrency: 2,
  });
  expect((await dw("config", "get")).out).toContain("agents.model = haiku");
});

test("invalid values are rejected and the file is left as it was", async () => {
  await dw("config", "set", "agents.maxTurns", "8");
  const before = readFileSync(file, "utf8");
  expect((await dw("config", "set", "agents.maxTurns", "0")).code).toBe(1);
  expect((await dw("config", "set", "agents.maxTurns", "many")).code).toBe(1);
  expect((await dw("config", "set", "agents.concurrency", "2.5")).code).toBe(1);
  expect((await dw("config", "set", "agents.color", "red")).code).toBe(1);
  expect((await dw("config", "set", "agents.model")).code).toBe(2);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a broken file is reported, not overwritten", async () => {
  writeFileSync(file, "{ nope");
  const get = await dw("config", "get");
  expect(get.code).toBe(1);
  expect(get.err).toContain("not valid JSON");
  expect((await dw("config", "set", "agents.model", "haiku")).code).toBe(1);
  expect(readFileSync(file, "utf8")).toBe("{ nope");
});
