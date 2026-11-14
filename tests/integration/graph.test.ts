/** Decision graph through the daemon (T-303): creation, propagation, events, errors. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONDITION_UNMET, PREREQUISITE_CLOSED } from "@dw/core";
import { type Daemon, startDaemon } from "@dw/daemon";
import { DwClient, type RpcCallError } from "@dw/ipc-client";
import { type Decision, type DwEvent, ErrorCode } from "@dw/protocol";

let dir: string;
let project: string;
let daemon: Daemon;
let c: DwClient;
let events: DwEvent[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-graph-"));
  project = join(dir, "p");
  const socketPath = join(dir, "d.sock");
  daemon = await startDaemon({ socketPath });
  c = await DwClient.connect({ socketPath });
  events = [];
  c.onEvent((e) => events.push(e));
  await c.call("events.subscribe", { project });
});

afterEach(async () => {
  c.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const where = [
  { id: "local", label: "ローカル" },
  { id: "cloud", label: "クラウド" },
];

/** D-1 保存先 → D-2 同期方式 (only if cloud) → D-3 競合解決 ; D-4 DB (any) */
async function plan(): Promise<Decision[]> {
  return c.call("decision.create", {
    project,
    decisions: [
      { key: "where", question: "保存先は？", kind: "single", options: where, origin: "plan" },
      {
        key: "sync",
        question: "同期方式は？",
        kind: "text",
        origin: "plan",
        dependsOn: [{ ref: "where", whenOptions: ["cloud"] }],
      },
      { key: "conflict", question: "競合の解決は？", kind: "text", dependsOn: [{ ref: "sync" }] },
      { key: "db", question: "DB は？", kind: "text", dependsOn: [{ ref: "where" }] },
    ],
  });
}

async function statuses(): Promise<Record<string, string>> {
  const all = await c.call("decision.list", { project });
  return Object.fromEntries(
    all.map((d) => [d.id, d.closedReason ? `${d.status}:${d.closedReason}` : d.status]),
  );
}

async function answer(id: string, a: { selected?: string[]; text?: string }) {
  const { decision } = await c.call("decision.get", { project, id });
  return c.call("decision.answer", {
    project,
    id,
    expectedVersion: decision.version,
    answer: { selected: a.selected ?? [], text: a.text },
  });
}

async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await Bun.sleep(5);
  }
}

test("new decisions start ready or pending depending on prerequisites (DG-06)", async () => {
  const created = await plan();
  expect(created.map((d) => d.status)).toEqual(["ready", "pending", "pending", "pending"]);
  expect(created[1]?.dependsOn).toEqual([{ id: "D-1", whenOptions: ["cloud"] }]);
});

test("answering opens or skips the branches, and the moved decisions are pushed as events", async () => {
  await plan();
  events = [];
  await answer("D-1", { selected: ["cloud"] });
  expect(await statuses()).toEqual({
    "D-1": "decided",
    "D-2": "ready",
    "D-3": "pending",
    "D-4": "ready",
  });
  await until(() => events.length >= 3);
  expect(events.map((e) => e.decision.id).sort()).toEqual(["D-1", "D-2", "D-4"]);
});

test("changing the answer moves everything downstream, keeping answers (DG-03, DG-04)", async () => {
  await plan();
  await answer("D-1", { selected: ["cloud"] });
  await answer("D-2", { text: "CRDT" });
  await answer("D-3", { text: "last write wins" });
  await answer("D-4", { text: "SQLite" });

  const { decision } = await c.call("decision.get", { project, id: "D-1" });
  await c.call("decision.transition", {
    project,
    id: "D-1",
    expectedVersion: decision.version,
    to: "revisit",
  });
  expect(await statuses()).toEqual({
    "D-1": "revisit",
    "D-2": "revisit",
    "D-3": "revisit",
    "D-4": "revisit",
  });

  await answer("D-1", { selected: ["local"] }); // no longer cloud
  expect(await statuses()).toEqual({
    "D-1": "decided",
    "D-2": `skipped:${CONDITION_UNMET}`,
    "D-3": `skipped:${PREREQUISITE_CLOSED}`,
    "D-4": "revisit",
  });
  const sync = await c.call("decision.get", { project, id: "D-2" });
  expect(sync.decision.answer).toEqual({ selected: [], text: "CRDT" }); // history kept (NFR-03)
});

test("a decision cannot be answered before its prerequisites", async () => {
  await plan();
  const error = await answer("D-4", { text: "x" }).catch((e: RpcCallError) => e);
  expect((error as RpcCallError).code).toBe(ErrorCode.InvalidTransition);
  expect((error as RpcCallError).message).toContain("D-1");
});

test("cycles and unknown refs are rejected with InvalidDependency (DG-02)", async () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e: RpcCallError) => e.code,
    );
  expect(
    await code(
      c.call("decision.create", {
        project,
        decisions: [
          { key: "a", question: "A?", kind: "text", dependsOn: [{ ref: "b" }] },
          { key: "b", question: "B?", kind: "text", dependsOn: [{ ref: "a" }] },
        ],
      }),
    ),
  ).toBe(ErrorCode.InvalidDependency);
  expect(
    await code(
      c.call("decision.create", {
        project,
        decisions: [{ question: "A?", kind: "text", dependsOn: [{ ref: "D-7" }] }],
      }),
    ),
  ).toBe(ErrorCode.InvalidDependency);
  expect(await c.call("decision.list", { project })).toEqual([]);
});

test("reopening a user-skipped decision brings it back as ready when its prerequisites allow", async () => {
  await plan();
  await answer("D-1", { selected: ["local"] });
  const { decision } = await c.call("decision.get", { project, id: "D-4" });
  const skipped = await c.call("decision.transition", {
    project,
    id: "D-4",
    expectedVersion: decision.version,
    to: "skipped",
  });
  const reopened = await c.call("decision.transition", {
    project,
    id: "D-4",
    expectedVersion: skipped.version,
    to: "pending",
  });
  expect(reopened.status).toBe("ready");
});
