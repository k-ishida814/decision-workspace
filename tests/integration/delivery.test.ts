/** UserPromptSubmit hook → daemon → context for Claude (T-312). The real hook process. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient } from "@dw/ipc-client";

const HOOK = join(import.meta.dir, "../../apps/hook/src/main.ts");
let dir: string;
let socketPath: string;
let project: string;
let daemon: Daemon | undefined;
let c: DwClient;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-deliver-"));
  socketPath = join(dir, "d.sock");
  project = join(dir, "p");
  mkdirSync(join(project, ".git"), { recursive: true });
  daemon = await startDaemon({ socketPath });
  c = await DwClient.connect({ socketPath });
});
afterEach(async () => {
  c.close();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run the hook as Claude Code would before a prompt; returns additionalContext or "". */
async function prompt(session: string): Promise<string> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: session,
        cwd: project,
        hook_event_name: "UserPromptSubmit",
        prompt: "続けて",
      }),
    ),
    stdout: "pipe",
    env: { ...process.env, DW_SOCKET: socketPath },
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  if (!out) return "";
  const json = JSON.parse(out);
  expect(json.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return json.hookSpecificOutput.additionalContext as string;
}

async function queue() {
  await c.call("plan.create", {
    project,
    request: "同期",
    source: "claude",
    decisions: [
      {
        key: "where",
        title: "保存先",
        question: "保存先は？",
        kind: "single",
        options: [
          { id: "1", label: "ローカル" },
          { id: "2", label: "クラウド" },
        ],
      },
      {
        key: "sync",
        title: "同期方式",
        question: "同期方式は？",
        kind: "text",
        dependsOn: [{ ref: "where" }],
      },
    ],
  });
}

const answer = async (id: string, a: { selected?: string[]; text?: string }, why?: string) => {
  const { decision } = await c.call("decision.get", { project, id });
  await c.call("decision.answer", {
    project,
    id,
    expectedVersion: decision.version,
    answer: { selected: a.selected ?? [], text: a.text },
    rationale: why,
  });
};

test("queue → answer in the UI → the next prompt carries the decisions, once (CC-09)", async () => {
  expect(await prompt("s1")).toBe(""); // first prompt of the session: baseline only
  await queue();
  expect(await prompt("s1")).toBe(""); // nothing decided yet

  await answer("D-1", { selected: ["2"] }, "複数端末");
  const first = await prompt("s1");
  expect(first).toContain("- D-1 保存先 → クラウド (reason: 複数端末)");
  expect(first).toContain("Open decisions: 1");
  expect(await prompt("s1")).toBe(""); // not repeated

  await answer("D-2", { text: "CRDT" });
  expect(await prompt("s1")).toContain("- D-2 同期方式 → CRDT");
});

test("a changed answer is delivered again with the previous value and what it affects", async () => {
  await prompt("s1");
  await queue();
  await answer("D-1", { selected: ["2"] });
  await answer("D-2", { text: "CRDT" });
  await prompt("s1");

  const { decision } = await c.call("decision.get", { project, id: "D-1" });
  await c.call("decision.transition", {
    project,
    id: "D-1",
    expectedVersion: decision.version,
    to: "revisit",
  });
  await answer("D-1", { selected: ["1"] });
  expect(await prompt("s1")).toContain(
    "- D-1 保存先 → ローカル (changed; was: クラウド); re-checking: D-2",
  );
});

test("a new session is not flooded with history; other sessions get new decisions too", async () => {
  await prompt("s1");
  await queue();
  await answer("D-1", { selected: ["1"] });
  expect(await prompt("s2")).toBe(""); // s2 starts after D-1 was decided
  await answer("D-2", { text: "rsync" });
  expect(await prompt("s1")).toContain("D-2");
  expect(await prompt("s2")).toContain("D-2");
});

test("AskUserQuestion answers are not repeated (Claude already has them)", async () => {
  await prompt("s1");
  const waiting = c.call("decision.askBatch", {
    project,
    batchId: "toolu_1",
    questions: [{ question: "言語は？", options: [{ label: "TS" }, { label: "Rust" }] }],
  });
  await Bun.sleep(30);
  await answer("D-1", { selected: ["1"] });
  await waiting;
  expect(await prompt("s1")).toBe("");
});

test("no daemon → the prompt goes through untouched", async () => {
  await daemon?.close();
  daemon = undefined;
  const started = Date.now();
  expect(await prompt("s1")).toBe("");
  expect(Date.now() - started).toBeLessThan(2000);
});
