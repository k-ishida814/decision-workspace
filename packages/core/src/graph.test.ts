import { describe, expect, test } from "bun:test";
import type { Decision, DecisionStatus, Dependency } from "@dw/protocol";
import {
  CONDITION_UNMET,
  dependentsOf,
  findCycle,
  gate,
  initialStatus,
  isActionable,
  PREREQUISITE_CLOSED,
  propagate,
} from "./graph";

const T0 = "2026-11-14T00:00:00.000Z";
const T1 = "2026-11-14T00:01:00.000Z";

function d(
  id: string,
  status: DecisionStatus,
  dependsOn: Dependency[] = [],
  selected: string[] = [],
  extra: Partial<Decision> = {},
): Decision {
  return {
    id,
    origin: "plan",
    dependsOn,
    title: "",
    question: `${id}?`,
    kind: "single",
    allowOther: true,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    status,
    held: false,
    version: 1,
    revision: status === "decided" || status === "revisit" ? 1 : 0,
    answer: selected.length > 0 ? { selected } : undefined,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

const map = (...ds: Decision[]) => new Map(ds.map((x) => [x.id, x]));
const statuses = (updates: Decision[]) =>
  Object.fromEntries(
    updates.map((u) => [u.id, u.closedReason ? `${u.status}:${u.closedReason}` : u.status]),
  );

describe("findCycle (DG-02)", () => {
  test("finds a cycle and reports its path", () => {
    expect(
      findCycle([
        d("D-1", "ready", [{ id: "D-3" }]),
        d("D-2", "ready", [{ id: "D-1" }]),
        d("D-3", "ready", [{ id: "D-2" }]),
      ]),
    ).toEqual(["D-1", "D-3", "D-2", "D-1"]);
  });
  test("a diamond is not a cycle", () => {
    expect(
      findCycle([
        d("D-1", "ready"),
        d("D-2", "ready", [{ id: "D-1" }]),
        d("D-3", "ready", [{ id: "D-1" }]),
        d("D-4", "ready", [{ id: "D-2" }, { id: "D-3" }]),
      ]),
    ).toBeUndefined();
  });
});

describe("gate / initialStatus (DG-04, DG-06)", () => {
  const cloud = d("D-1", "decided", [], ["a"]);
  test("waits while a prerequisite is open", () => {
    const child = d("D-2", "ready", [{ id: "D-1" }]);
    expect(gate(child, map(d("D-1", "ready"), child))).toBe("blocked");
    expect(initialStatus(child, map(d("D-1", "ready")))).toEqual({
      status: "pending",
      closedReason: undefined,
    });
  });
  test("conditions select on the parent's chosen options", () => {
    expect(gate(d("D-2", "ready", [{ id: "D-1", whenOptions: ["a"] }]), map(cloud))).toBe("open");
    expect(gate(d("D-2", "ready", [{ id: "D-1", whenOptions: ["b"] }]), map(cloud))).toEqual({
      unmet: CONDITION_UNMET,
    });
  });
  test("a skipped or cancelled prerequisite closes its dependents", () => {
    expect(gate(d("D-2", "ready", [{ id: "D-1" }]), map(d("D-1", "skipped")))).toEqual({
      unmet: PREREQUISITE_CLOSED,
    });
  });
  test("a revisit with an open prerequisite is not actionable", () => {
    const child = d("D-2", "revisit", [{ id: "D-1" }], ["a"]);
    expect(isActionable(child, map(d("D-1", "revisit", [], ["a"]), child))).toBe(false);
    expect(isActionable(child, map(cloud, child))).toBe(true);
  });
});

describe("propagate (DG-03, D2)", () => {
  test("answering a parent makes its children ready or skips them by condition", () => {
    const parent = d("D-1", "decided", [], ["a"]);
    const onA = d("D-2", "pending", [{ id: "D-1", whenOptions: ["a"] }]);
    const onB = d("D-3", "pending", [{ id: "D-1", whenOptions: ["b"] }]);
    const updates = propagate(parent, [parent, onA, onB], T1);
    expect(statuses(updates)).toEqual({ "D-2": "ready", "D-3": `skipped:${CONDITION_UNMET}` });
    expect(updates[0]).toMatchObject({ version: 2, updatedAt: T1 });
  });

  test("reopening a parent sends decided descendants to revisit and open ones back to pending", () => {
    const root = d("D-1", "revisit", [], ["a"]);
    const child = d("D-2", "decided", [{ id: "D-1" }], ["a"]);
    const grandchild = d("D-3", "decided", [{ id: "D-2" }], ["b"]);
    const sibling = d("D-4", "ready", [{ id: "D-1" }]);
    expect(statuses(propagate(root, [root, child, grandchild, sibling], T1))).toEqual({
      "D-2": "revisit",
      "D-3": "revisit",
      "D-4": "pending",
    });
  });

  test("changing the answer flips which conditional branch applies; answers are kept", () => {
    const parent = d("D-1", "decided", [], ["b"]); // re-answered: a → b
    const onA = d("D-2", "revisit", [{ id: "D-1", whenOptions: ["a"] }], ["a"]);
    const onB = d("D-3", "skipped", [{ id: "D-1", whenOptions: ["b"] }], [], {
      closedReason: CONDITION_UNMET,
    });
    const updates = propagate(parent, [parent, onA, onB], T1);
    expect(statuses(updates)).toEqual({ "D-2": `skipped:${CONDITION_UNMET}`, "D-3": "ready" });
    expect(updates.find((u) => u.id === "D-2")?.answer).toEqual({ selected: ["a"] });
  });

  test("an auto-skipped decision that had been answered comes back as revisit", () => {
    const parent = d("D-1", "decided", [], ["a"]);
    const child = d("D-2", "skipped", [{ id: "D-1", whenOptions: ["a"] }], ["a"], {
      closedReason: CONDITION_UNMET,
      revision: 1,
    });
    expect(statuses(propagate(parent, [parent, child], T1))).toEqual({ "D-2": "revisit" });
  });

  test("skipping a parent closes the whole subtree; the user's own skips and cancels are untouched", () => {
    const parent = d("D-1", "skipped", [], [], { closedReason: "user" });
    const child = d("D-2", "ready", [{ id: "D-1" }]);
    const grandchild = d("D-3", "pending", [{ id: "D-2" }]);
    const userSkipped = d("D-4", "skipped", [{ id: "D-1" }], [], { closedReason: "user" });
    const cancelled = d("D-5", "cancelled", [{ id: "D-1" }]);
    expect(
      statuses(propagate(parent, [parent, child, grandchild, userSkipped, cancelled], T1)),
    ).toEqual({
      "D-2": `skipped:${PREREQUISITE_CLOSED}`,
      "D-3": `skipped:${PREREQUISITE_CLOSED}`,
    });
  });

  test("diamond: the join waits for both sides", () => {
    const root = d("D-1", "decided", [], ["a"]);
    const left = d("D-2", "decided", [{ id: "D-1" }], ["a"]);
    const right = d("D-3", "pending", [{ id: "D-1" }]);
    const join = d("D-4", "pending", [{ id: "D-2" }, { id: "D-3" }]);
    const all = [root, left, right, join];
    expect(statuses(propagate(root, all, T1))).toEqual({ "D-3": "ready" });
    const rightDone = d("D-3", "decided", [{ id: "D-1" }], ["b"]);
    expect(statuses(propagate(rightDone, [root, left, rightDone, join], T1))).toEqual({
      "D-4": "ready",
    });
  });

  test("dependentsOf walks the whole subtree once", () => {
    const all = [
      d("D-1", "ready"),
      d("D-2", "ready", [{ id: "D-1" }]),
      d("D-3", "ready", [{ id: "D-1" }]),
      d("D-4", "ready", [{ id: "D-2" }, { id: "D-3" }]),
    ];
    expect(dependentsOf("D-1", all).map((x) => x.id)).toEqual(["D-2", "D-3", "D-4"]);
  });
});
