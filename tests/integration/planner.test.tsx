/** Planner through daemon, CLI and TUI with a fake claude (T-309). No model is called. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";
import type { RunEvent } from "@dw/protocol";
import { App, daemonBackend } from "@dw/tui";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";

const FAKE = join(import.meta.dir, "../../packages/agent-runner/test/fake-claude.ts");
const env = { ...process.env };
let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon;
let ui: TestRendererSetup | undefined;
const clients: DwClient[] = [];

const plan = (decisions: unknown[]) => JSON.stringify({ decisions });
const good = plan([
  {
    key: "storage",
    title: "保存先",
    question: "保存先は？",
    multiSelect: false,
    options: [
      { label: "ローカル", description: "端末内" },
      { label: "クラウド", description: "複数端末" },
    ],
    dependsOn: [],
  },
  {
    key: "sync",
    title: "同期方式",
    question: "同期方式は？",
    multiSelect: false,
    options: [],
    dependsOn: [{ ref: "storage", whenOptions: ["クラウド"] }],
  },
  {
    key: "backup",
    title: "バックアップ",
    question: "バックアップの頻度は？",
    multiSelect: false,
    options: [],
    dependsOn: [{ ref: "storage", whenOptions: [] }],
  },
]);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-planner-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "p");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_OUTPUT = good;
  process.env.FAKE_ARGS_FILE = join(dir, "args.json");
  daemon = await startDaemon({ socketPath, claudeCommand: ["bun", FAKE] });
});
afterEach(async () => {
  process.env = { ...env };
  await ui?.dispose();
  ui = undefined;
  for (const c of clients.splice(0)) c.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function client(): Promise<DwClient> {
  const c = await DwClient.connect({ socketPath });
  clients.push(c);
  return c;
}

async function generate(request: string): Promise<RunEvent> {
  const c = await client();
  const finished = new Promise<RunEvent>((resolve) =>
    c.onRun((e) => {
      if (e.run.status !== "running") resolve(e);
    }),
  );
  await c.call("events.subscribe", { project });
  const started = await c.call("plan.generate", { project, request });
  expect(started.plan).toMatchObject({ id: "P-1", status: "planning", source: "user" });
  return finished;
}

describe("daemon (T-309)", () => {
  test("a plan becomes decisions with dependencies and conditions; the plan is ready", async () => {
    const { run: r } = await generate("同期機能を追加したい");
    expect(r).toMatchObject({ kind: "planner", target: "P-1", status: "succeeded" });
    const c = await client();
    const all = await c.call("decision.list", { project });
    expect(all.map((d) => [d.id, d.status, d.origin, d.planId, d.kind])).toEqual([
      ["D-1", "ready", "plan", "P-1", "single"],
      ["D-2", "pending", "plan", "P-1", "text"],
      ["D-3", "pending", "plan", "P-1", "text"],
    ]);
    expect(all[1]?.dependsOn).toEqual([{ id: "D-1", whenOptions: ["2"] }]);
    expect(all[2]?.dependsOn).toEqual([{ id: "D-1" }]); // empty whenOptions = unconditional
    expect((await c.call("plan.list", { project }))[0]?.status).toBe("ready");
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
    expect(args[args.indexOf("-p") + 1]).toContain("Request: 同期機能を追加したい");
  });

  test("existing decisions are given as context so they are not asked again", async () => {
    const c = await client();
    await c.call("decision.create", {
      project,
      decisions: [{ question: "言語は？", kind: "text" }],
    });
    await generate("同期");
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
    expect(args[args.indexOf("-p") + 1]).toContain("Already open (do not repeat):\n- 言語は？");
  });

  test("an unusable plan (cycle, unknown label) fails cleanly: nothing created, plan failed", async () => {
    process.env.FAKE_OUTPUT = plan([
      {
        key: "a",
        title: "A",
        question: "A?",
        multiSelect: false,
        options: [],
        dependsOn: [{ ref: "b", whenOptions: [] }],
      },
      {
        key: "b",
        title: "B",
        question: "B?",
        multiSelect: false,
        options: [],
        dependsOn: [{ ref: "a", whenOptions: [] }],
      },
    ]);
    const { run: r } = await generate("x");
    expect(r.status).toBe("failed");
    expect(r.error).toContain("cycle");
    const c = await client();
    expect(await c.call("decision.list", { project })).toEqual([]);
    expect((await c.call("plan.list", { project }))[0]?.status).toBe("failed");

    process.env.FAKE_OUTPUT = plan([
      {
        key: "a",
        title: "A",
        question: "A?",
        multiSelect: false,
        options: [{ label: "X", description: "" }],
        dependsOn: [],
      },
      {
        key: "b",
        title: "B",
        question: "B?",
        multiSelect: false,
        options: [],
        dependsOn: [{ ref: "a", whenOptions: ["Y"] }],
      },
    ]);
    const second = await c.call("plan.generate", { project, request: "y" });
    await Bun.sleep(400);
    const runs = await c.call("agent.list", { project, target: second.plan.id });
    expect(runs[0]?.error).toContain('"a" has no option "Y"');
  });
});

describe("CLI and TUI (T-309)", () => {
  async function dw(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      [...argv, "--socket", socketPath, "--project", project],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { autoStart: () => {} },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("dw plan waits and prints the new plan as a tree", async () => {
    const r = await dw("plan", "同期機能を追加したい");
    expect(r.code).toBe(0);
    expect(r.err).toContain("Planning P-1 (R-1");
    expect(r.out).toContain("P-1 同期機能を追加したい");
    expect(r.out).toContain("├─ D-2 [pending] 同期方式  (when D-1 = クラウド)");
    expect(r.out).toContain("answer them in dw tui");
    expect((await dw("plan")).code).toBe(2);
  });

  test("p in the TUI asks for a request and the plan appears", async () => {
    const backend = daemonBackend(await client(), project);
    ui = await testRender(<App backend={backend} />, { width: 100, height: 30 });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const frame = async (pred: (f: string) => boolean) => {
      const s = ui as TestRendererSetup;
      const deadline = Date.now() + 4000;
      let last = "";
      while (Date.now() < deadline) {
        await s.renderOnce();
        last = s.captureCharFrame();
        if (pred(last)) return last;
        await Bun.sleep(10);
      }
      throw new Error(`frame did not match:\n${last}`);
    };
    await frame((f) => f.includes("Waiting for Claude Code"));
    ui.mockInput.pressKey("p");
    await frame((f) => f.includes("The Planner lists the decisions to make"));
    await ui.mockInput.typeText("sync");
    ui.mockInput.pressEnter();
    await frame((f) => f.includes("Planning P-1 finished"));
    await frame((f) => f.includes("保存先は？")); // the first decision is ready in Current
  });
});
