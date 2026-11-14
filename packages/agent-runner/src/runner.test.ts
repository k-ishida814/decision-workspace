import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_TOOLS, type AgentSpec, type RunnerOptions, runAgent, Semaphore } from "./runner";

const FAKE = join(import.meta.dir, "../test/fake-claude.ts");
let dir: string;
const env = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dw-runner-"));
});
afterEach(() => {
  process.env = { ...env };
  rmSync(dir, { recursive: true, force: true });
});

const spec: AgentSpec<{ answer: string; score: number }> = {
  kind: "explorer",
  schema: z.object({ answer: z.string(), score: z.number() }),
  systemPrompt: "You are a test.",
  prompt: "<data>q</data>",
  cwd: process.cwd(),
};

function options(extra: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    model: "sonnet",
    maxBudgetUsd: 0.5,
    maxTurns: 12,
    runsDir: join(dir, "runs"),
    runId: "R-1",
    command: ["bun", FAKE],
    ...extra,
  };
}

function mode(m: string) {
  process.env.FAKE_MODE = m;
  process.env.FAKE_COUNTER = join(dir, "count");
}

describe("runAgent (T-307)", () => {
  test("success: validated output, metrics, tool counts, transcript on disk", async () => {
    mode("ok");
    const r = await runAgent(spec, options());
    expect(r.status).toBe("succeeded");
    if (r.status !== "succeeded") return;
    expect(r.output).toEqual({ answer: "ok", score: 3 });
    expect(r.metrics).toMatchObject({
      costUsd: 0.01,
      inputTokens: 150,
      outputTokens: 20,
      turns: 2,
      attempts: 1,
      toolCalls: { Read: 1, WebSearch: 1 },
    });
    const lines = readFileSync(r.metrics.transcriptPath, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["system", "assistant", "result"]);
  });

  test("passes the agreed flags: read-only tools, caps, no hooks, no MCP, draft-7 schema", async () => {
    mode("ok");
    process.env.FAKE_ARGS_FILE = join(dir, "args.json");
    await runAgent(spec, options({ model: "haiku", maxBudgetUsd: 0.25, maxTurns: 7 }));
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--model")).toBe("haiku");
    expect(after("--tools")).toBe(AGENT_TOOLS);
    expect(after("--allowedTools")).toBe(AGENT_TOOLS);
    expect(after("--max-turns")).toBe("7");
    expect(after("--max-budget-usd")).toBe("0.25");
    expect(JSON.parse(after("--settings") ?? "")).toEqual({ disableAllHooks: true });
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(JSON.parse(after("--json-schema") ?? "").$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
  });

  test("an invalid output is retried once, and the costs of both attempts add up", async () => {
    mode("invalid-then-ok");
    const r = await runAgent(spec, options());
    expect(r.status).toBe("succeeded");
    expect(r.metrics.attempts).toBe(2);
    expect(r.metrics.costUsd).toBeCloseTo(0.02);
  });

  test("still invalid after retrying → failed with the schema problem", async () => {
    mode("invalid");
    const r = await runAgent(spec, options());
    expect(r).toMatchObject({ status: "failed", metrics: { attempts: 2 } });
    if (r.status === "failed") expect(r.error).toContain("does not match the schema");
    mode("missing");
    const missing = await runAgent(spec, options({ runId: "R-2" }));
    expect(missing).toMatchObject({ status: "failed", error: "no structured output" });
  });

  test("claude-side errors and crashes are not retried", async () => {
    mode("error");
    const budget = await runAgent(spec, options());
    expect(budget).toMatchObject({ status: "failed", metrics: { attempts: 1 } });
    if (budget.status === "failed") expect(budget.error).toContain("error_max_budget_usd");
    mode("crash");
    const crash = await runAgent(spec, options({ runId: "R-2" }));
    expect(crash).toMatchObject({ status: "failed", metrics: { attempts: 1 } });
    if (crash.status === "failed") expect(crash.error).toContain("not logged in");
  });

  test("timeout kills the process", async () => {
    mode("hang");
    const started = Date.now();
    const r = await runAgent(spec, options({ timeoutMs: 300 }));
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("abort signal cancels a running agent", async () => {
    mode("hang");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await runAgent(spec, options({ signal: controller.signal }));
    expect(r.status).toBe("cancelled");
    expect(existsSync(r.metrics.transcriptPath)).toBe(true);
  });
});

test("Semaphore never runs more than its limit", async () => {
  const s = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      s.use(async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(20);
        active--;
      }),
    ),
  );
  expect(peak).toBe(2);
});
