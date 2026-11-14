/** Reviewer through daemon, CLI and TUI with a fake claude (T-310). No model is called. */
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

const proposal = (over: Record<string, unknown>) => ({
  kind: "conflict",
  title: "オフラインと同期",
  reason: "オフライン専用なのにリアルタイム同期を選んでいる",
  decisionIds: ["D-1", "D-2"],
  question: "",
  multiSelect: false,
  options: [],
  ...over,
});
const review = (proposals: unknown[]) => JSON.stringify({ proposals });
const good = review([
  proposal({}),
  proposal({
    kind: "add",
    title: "認証",
    reason: "サーバーを使うなら認証が要る",
    decisionIds: ["D-2"],
    question: "認証方式は？",
    options: [{ label: "OAuth", description: "外部 ID" }],
  }),
  proposal({ kind: "revisit", decisionIds: ["D-99"] }), // unknown id: dropped
]);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-reviewer-"));
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

/** D-1 storage = local (decided), D-2 sync = realtime (decided), D-3 open. */
async function seed(): Promise<DwClient> {
  const c = await client();
  const [d1, d2] = await c.call("decision.create", {
    project,
    decisions: [
      {
        title: "保存先",
        question: "保存先は？",
        kind: "single",
        options: [
          { id: "1", label: "ローカルのみ" },
          { id: "2", label: "クラウド" },
        ],
      },
      {
        title: "同期",
        question: "同期方式は？",
        kind: "single",
        options: [
          { id: "1", label: "リアルタイム" },
          { id: "2", label: "手動" },
        ],
      },
      { title: "UI", question: "テーマは？", kind: "text" },
    ],
  });
  for (const d of [d1, d2]) {
    if (!d) throw new Error("seed failed");
    await c.call("decision.answer", {
      project,
      id: d.id,
      expectedVersion: d.version,
      answer: { selected: ["1"] },
      rationale: "速さ優先",
    });
  }
  return c;
}

async function reviewed(): Promise<{ c: DwClient; run: RunEvent["run"] }> {
  const c = await seed();
  const finished = new Promise<RunEvent>((resolve) =>
    c.onRun((e) => {
      if (e.run.status !== "running") resolve(e);
    }),
  );
  await c.call("events.subscribe", { project });
  const started = await c.call("review.start", { project });
  expect(started).toMatchObject({ kind: "reviewer", target: "project", status: "running" });
  return { c, run: (await finished).run };
}

describe("daemon (T-310)", () => {
  test("proposals are stored, checked against the decisions, and nothing changes yet", async () => {
    const { c, run: r } = await reviewed();
    expect(r.status).toBe("succeeded");
    const proposals = await c.call("review.list", { project, status: ["open"] });
    expect(proposals.map((p) => [p.id, p.kind, p.decisionIds])).toEqual([
      ["RV-1", "conflict", ["D-1", "D-2"]],
      ["RV-2", "add", ["D-2"]],
    ]);
    expect((await c.call("decision.list", { project })).map((d) => d.status)).toEqual([
      "decided",
      "decided",
      "ready",
    ]);
    // The decided answers and rationale go to the agent; open ones only as "do not repeat".
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    expect(prompt).toContain("- D-1 (保存先): 保存先は？ → ローカルのみ (reason: 速さ優先)");
    expect(prompt).toContain("Still open (do not propose these again):\n- D-3: テーマは？");
  });

  test("accepting a conflict reopens the decided ones; add creates a decision after them", async () => {
    const { c } = await reviewed();
    const conflict = await c.call("review.resolve", { project, id: "RV-1", accept: true });
    expect(conflict.proposal.status).toBe("accepted");
    expect(conflict.decisions.map((d) => [d.id, d.status])).toEqual([
      ["D-1", "revisit"],
      ["D-2", "revisit"],
    ]);
    // D-2 is no longer decided, so the new decision waits for it.
    const add = await c.call("review.resolve", { project, id: "RV-2", accept: true });
    expect(add.decisions.map((d) => [d.id, d.status, d.kind, d.dependsOn])).toEqual([
      ["D-4", "pending", "single", [{ id: "D-2" }]],
    ]);
    await expect(c.call("review.resolve", { project, id: "RV-2", accept: false })).rejects.toThrow(
      "already accepted",
    );
    expect(await c.call("review.list", { project, status: ["open"] })).toEqual([]);
  });

  test("a new review supersedes open proposals; nothing decided is refused", async () => {
    const { c } = await reviewed();
    const finished = new Promise<void>((resolve) =>
      c.onRun((e) => {
        if (e.run.status !== "running") resolve();
      }),
    );
    process.env.FAKE_OUTPUT = review([]);
    await c.call("review.start", { project });
    await finished;
    const all = await c.call("review.list", { project });
    expect(all.map((p) => p.status)).toEqual(["superseded", "superseded"]);

    await expect(c.call("review.start", { project, planId: "P-9" })).rejects.toThrow(
      "nothing decided in P-9 yet",
    );
  });
});

describe("CLI and TUI (T-310)", () => {
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

  test("dw review prints proposals; dw accept / dismiss resolve them", async () => {
    await seed();
    const r = await dw("review");
    expect(r.code).toBe(0);
    expect(r.err).toContain("Reviewing the project");
    expect(r.out).toContain("RV-1 [conflict] オフラインと同期");
    expect(r.out).toContain("    reopen: D-1 保存先, D-2 同期");
    expect(r.out).toContain("    add: 認証方式は？ (OAuth)");
    expect((await dw("dismiss", "RV-1")).out).toBe("RV-1 dismissed");
    expect((await dw("accept", "RV-2")).out).toBe("RV-2 accepted: added D-4");
    expect((await dw("proposals")).out).toBe("no open proposals");
    expect((await dw("proposals", "--all")).out).toContain(
      "RV-1 [conflict] オフラインと同期 (dismissed)",
    );
    expect((await dw("accept", "D-1")).code).toBe(2);
  });

  test("r reviews; proposals show in History; a accepts and the reopened one opens", async () => {
    const c = await seed();
    const backend = daemonBackend(c, project);
    ui = await testRender(<App backend={backend} />, { width: 110, height: 40 });
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
    await frame((f) => f.includes("テーマは？"));
    ui.mockInput.pressKey("r");
    await frame((f) => f.includes("Review finished"));
    ui.mockInput.pressTab();
    ui.mockInput.pressTab(); // History
    await frame(
      (f) => f.includes("RV-1 [conflict] オフラインと同期") && f.includes("RV-2 [add] 認証"),
    );
    ui.mockInput.pressKey("a");
    // D-1 reopens and is shown in Current with its previous answer.
    await frame((f) => f.includes("保存先は？") && f.includes("was: ローカルのみ"));
  });
});
