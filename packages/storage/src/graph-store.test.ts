import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, StoreError } from "./store";

const T0 = "2026-11-14T00:00:00.000Z";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function memory(): Store {
  const s = new Store(":memory:");
  cleanups.push(() => s.close());
  return s;
}

const yesNo = [
  { id: "y", label: "Yes" },
  { id: "n", label: "No" },
];

describe("migrations", () => {
  test("a new database gets the schema once; reopening keeps the data", () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-mig-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "decisions.db");
    const first = new Store(path);
    first.create([{ question: "Q?", kind: "text" }], T0);
    first.close();
    const s = new Store(path);
    cleanups.push(() => s.close());
    expect(s.list().map((d) => [d.id, d.origin])).toEqual([["D-1", "manual"]]);
    expect((s.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      1,
    );
  });
});

describe("dependencies", () => {
  test("keys wire decisions created together; conditions are kept", () => {
    const s = memory();
    const [storage, sync] = s.create(
      [
        {
          key: "storage",
          question: "Cloud?",
          kind: "single",
          options: yesNo,
          origin: "plan",
          planId: "P-1",
        },
        {
          key: "sync",
          question: "Sync how?",
          kind: "text",
          dependsOn: [{ ref: "storage", whenOptions: ["y"] }],
        },
      ],
      T0,
    );
    expect(storage).toMatchObject({ id: "D-1", origin: "plan", planId: "P-1", dependsOn: [] });
    expect(sync?.dependsOn).toEqual([{ id: "D-1", whenOptions: ["y"] }]);
    expect(s.get("D-2")?.dependsOn).toEqual([{ id: "D-1", whenOptions: ["y"] }]);
  });

  test("can depend on an existing decision by id", () => {
    const s = memory();
    s.create([{ question: "A?", kind: "text" }], T0);
    const [b] = s.create([{ question: "B?", kind: "text", dependsOn: [{ ref: "D-1" }] }], T0);
    expect(b?.dependsOn).toEqual([{ id: "D-1" }]);
  });

  test("unknown refs, self references and duplicate keys are rejected atomically", () => {
    const s = memory();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as StoreError).code;
      }
      return "none";
    };
    expect(
      code(() => s.create([{ question: "A?", kind: "text", dependsOn: [{ ref: "D-9" }] }], T0)),
    ).toBe("InvalidDependency");
    expect(
      code(() =>
        s.create([{ key: "a", question: "A?", kind: "text", dependsOn: [{ ref: "a" }] }], T0),
      ),
    ).toBe("InvalidDependency");
    expect(
      code(() =>
        s.create(
          [
            { key: "a", question: "A?", kind: "text" },
            { key: "a", question: "B?", kind: "text" },
          ],
          T0,
        ),
      ),
    ).toBe("InvalidDependency");
    expect(s.list()).toEqual([]); // nothing half-created
  });
});

describe("agent runs (AG-05)", () => {
  test("start, finish, list; finishing twice is an error", () => {
    const s = memory();
    const run = s.startRun({ kind: "explorer", target: "D-1", model: "sonnet" }, T0);
    expect(run).toEqual({
      id: "R-1",
      kind: "explorer",
      target: "D-1",
      model: "sonnet",
      status: "running",
      startedAt: T0,
    });
    const done = s.finishRun("R-1", {
      status: "succeeded",
      durationMs: 1200,
      costUsd: 0.08,
      inputTokens: 25000,
      outputTokens: 1300,
      transcriptPath: "/x/R-1.jsonl",
    });
    expect(done).toMatchObject({ status: "succeeded", costUsd: 0.08, durationMs: 1200 });
    expect(() => s.finishRun("R-1", { status: "failed" })).toThrow(StoreError);
    expect(s.startRun({ kind: "planner", target: "P-1", model: "sonnet" }, T0).id).toBe("R-2");
    expect(s.runs("D-1").map((r) => r.id)).toEqual(["R-1"]);
  });

  test("runs left running by a dead daemon are marked failed", () => {
    const s = memory();
    s.startRun({ kind: "explorer", target: "D-1", model: "sonnet" }, T0);
    expect(s.abandonRunningRuns("daemon restarted")).toBe(1);
    expect(s.runs()[0]).toMatchObject({ status: "failed", error: "daemon restarted" });
  });
});

test("a database from a pre-0.1.0 development build is refused, not used", () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-old-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "decisions.db");
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const old = new Database(path);
  old.exec("CREATE TABLE decisions (seq INTEGER PRIMARY KEY, id TEXT); PRAGMA user_version = 1");
  old.close();
  expect(() => new Store(path)).toThrow("development build of dw before 0.1.0");
});
