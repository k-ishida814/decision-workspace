import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DomainError, FALLBACK_REASON } from "@dw/core";
import type { NewDecision } from "@dw/protocol";
import { dbPathFor, Store, type StoreError } from "./store";

const T0 = "2026-11-13T00:00:00.000Z";
const T1 = "2026-11-13T00:01:00.000Z";

const db: NewDecision = {
  question: "DB?",
  kind: "single",
  options: [
    { id: "a", label: "SQLite" },
    { id: "b", label: "Postgres" },
  ],
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function memory(): Store {
  const s = new Store(":memory:");
  cleanups.push(() => s.close());
  return s;
}

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function expectCode(fn: () => unknown, code: StoreError["code"] | DomainError["code"]) {
  try {
    fn();
  } catch (e) {
    expect((e as StoreError | DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected error ${code}`);
}

describe("Store", () => {
  test("assigns sequential D-n ids and round-trips decisions", () => {
    const s = memory();
    const [a, b] = s.create([db, { question: "Note?", kind: "text" }], T0);
    expect([a?.id, b?.id]).toEqual(["D-1", "D-2"]);
    expect(s.get("D-1")).toEqual(a);
    expect(s.create([db], T0)[0]?.id).toBe("D-3");
    expect(s.list(["ready"]).map((d) => d.id)).toEqual(["D-1", "D-2", "D-3"]);
  });

  test("answer bumps version, keeps every revision (DQ-05)", () => {
    const s = memory();
    s.create([db], T0);
    const first = s.answer("D-1", 1, { selected: ["a"] }, "offline", T1);
    const revisit = s.transition("D-1", first.version, "revisit", "requirements changed", T1);
    s.answer("D-1", revisit.version, { selected: ["b"] }, undefined, T1);
    expect(s.get("D-1")).toMatchObject({ status: "decided", revision: 2, version: 4 });
    expect(s.revisions("D-1").map((r) => [r.revision, r.answer.selected, r.rationale])).toEqual([
      [1, ["a"], "offline"],
      [2, ["b"], undefined],
    ]);
  });

  test("a stale expectedVersion is a Conflict and changes nothing (DQ-07)", () => {
    const s = memory();
    s.create([db], T0);
    s.answer("D-1", 1, { selected: ["a"] }, undefined, T1);
    expectCode(() => s.answer("D-1", 1, { selected: ["b"] }, undefined, T1), "Conflict");
    expect(s.get("D-1")?.answer).toEqual({ selected: ["a"] });
    expect(s.revisions("D-1")).toHaveLength(1);
  });

  test("two connections confirming the same decision: exactly one wins (NFR-02)", () => {
    const path = dbPathFor(tempProject());
    const tui = new Store(path);
    const vscode = new Store(path);
    cleanups.push(
      () => tui.close(),
      () => vscode.close(),
    );
    tui.create([db], T0);
    const seen = vscode.get("D-1");
    tui.answer("D-1", 1, { selected: ["a"] }, undefined, T1);
    expectCode(
      () => vscode.answer("D-1", seen?.version ?? 0, { selected: ["b"] }, undefined, T1),
      "Conflict",
    );
    expect(tui.revisions("D-1")).toHaveLength(1);
  });

  test("domain errors pass through and roll back", () => {
    const s = memory();
    s.create([db], T0);
    expectCode(() => s.answer("D-1", 1, { selected: ["zzz"] }, undefined, T1), "InvalidAnswer");
    expect(s.get("D-1")).toMatchObject({ status: "ready", version: 1 });
    expectCode(() => s.answer("D-9", 1, { selected: ["a"] }, undefined, T1), "NotFound");
  });

  test("cancelBatch cancels only open decisions of that batch", () => {
    const s = memory();
    s.create(
      [
        { ...db, batchId: "t1", batchIndex: 0 },
        { ...db, batchId: "t1", batchIndex: 1 },
        { ...db, batchId: "t2", batchIndex: 0 },
      ],
      T0,
    );
    s.answer("D-1", 1, { selected: ["a"] }, undefined, T1);
    const cancelled = s.cancelBatch("t1", FALLBACK_REASON, T1);
    expect(cancelled.map((d) => d.id)).toEqual(["D-2"]);
    expect(s.byBatch("t1").map((d) => d.status)).toEqual(["decided", "cancelled"]);
    expect(s.get("D-3")?.status).toBe("ready");
  });

  test("data survives reopening the database (NFR-01)", () => {
    const path = dbPathFor(tempProject());
    const first = new Store(path);
    first.create([db, db], T0);
    first.answer("D-1", 1, { selected: ["a"] }, undefined, T1);
    first.close();
    const second = new Store(path);
    cleanups.push(() => second.close());
    expect(second.list().map((d) => d.status)).toEqual(["decided", "ready"]);
    expect(second.create([db], T1)[0]?.id).toBe("D-3");
  });
});
