import { describe, expect, test } from "bun:test";
import type { Decision } from "@dw/protocol";
import { answerDecision, createDecision, DISCONNECT_REASON, transitionDecision } from "./decision";
import {
  currentDecision,
  initialUiState,
  selectedDecision,
  type UiAction,
  type UiState,
  uiReducer,
} from "./ui";

const T0 = "2026-11-13T00:00:00.000Z";
const T1 = "2026-11-13T00:01:00.000Z";

const lang = createDecision(
  {
    question: "Lang?",
    kind: "single",
    batchId: "toolu_1",
    batchIndex: 0,
    options: [
      { id: "1", label: "TS" },
      { id: "2", label: "Rust" },
    ],
  },
  "D-1",
  T0,
);
const editors = createDecision(
  {
    question: "Editors?",
    kind: "multi",
    batchId: "toolu_1",
    batchIndex: 1,
    options: [
      { id: "1", label: "VS Code" },
      { id: "2", label: "Neovim" },
      { id: "3", label: "Zed" },
    ],
  },
  "D-2",
  T0,
);
const note = createDecision({ question: "Note?", kind: "text" }, "D-3", T1);

const run = (s: UiState, ...actions: UiAction[]) => actions.reduce(uiReducer, s);
const synced = (...decisions: Decision[]) => run(initialUiState, { type: "sync", decisions });

describe("Current", () => {
  test("number + Enter sends an answer with the version it saw, then shows the next decision", () => {
    const s = run(synced(lang, editors), { type: "number", n: 2 }, { type: "confirm" });
    expect(s.outbox).toEqual([
      { type: "answer", id: "D-1", expectedVersion: 1, answer: { selected: ["2"] } },
    ]);
    expect(currentDecision(s)?.id).toBe("D-2"); // D-1 is in flight
  });

  test("multi-select toggles in option order", () => {
    const s = run(
      synced(editors),
      { type: "number", n: 3 },
      { type: "number", n: 1 },
      { type: "number", n: 3 },
      { type: "number", n: 3 },
      { type: "confirm" },
    );
    expect(s.outbox[0]).toMatchObject({ answer: { selected: ["1", "3"] } });
  });

  test("rationale typed with `w` goes with the next answer (DQ-04)", () => {
    const s = run(
      synced(lang),
      { type: "edit", mode: "why" },
      { type: "submitText", value: "型が欲しい" },
      { type: "confirm" },
    );
    expect(s.outbox[0]).toMatchObject({ rationale: "型が欲しい", answer: { selected: ["1"] } });
  });

  test("text decisions open the editor on Enter; free text answers", () => {
    const s = run(synced(note), { type: "confirm" });
    expect(s.editing).toBe("answer");
    const sent = uiReducer(s, { type: "submitText", value: " なし " });
    expect(sent.outbox[0]).toMatchObject({ answer: { selected: [], text: "なし" } });
  });

  test("skip / hold / fallback produce commands", () => {
    expect(run(synced(lang), { type: "skip" }).outbox[0]).toMatchObject({
      type: "transition",
      to: "skipped",
    });
    expect(run(synced(lang), { type: "hold" }).outbox[0]).toMatchObject({
      type: "hold",
      held: true,
    });
    const fb = run(synced(lang, editors), { type: "fallback" });
    expect(fb.outbox).toEqual([{ type: "fallback", batchId: "toolu_1" }]);
    expect(currentDecision(fb)).toBeUndefined(); // whole batch is in flight
    expect(run(synced(note), { type: "fallback" }).notice).toContain("nothing to hand back");
  });
});

test("a decision waiting on a prerequisite is never shown in Current (DG-06)", () => {
  const parent = createDecision({ question: "Parent?", kind: "text" }, "D-8", T0);
  const waiting: Decision = { ...note, id: "D-9", status: "pending", dependsOn: [{ id: "D-8" }] };
  expect(currentDecision(synced(waiting, parent))?.id).toBe("D-8");
  expect(currentDecision(synced(waiting))).toBeUndefined();
});

describe("sync", () => {
  test("in-flight settles when the decision changes; a failure brings it back with a notice", () => {
    const sent = run(synced(lang, editors), { type: "confirm" });
    const done = answerDecision(lang, { selected: ["1"] }, undefined, T1).decision;
    expect(uiReducer(sent, { type: "sync", decisions: [done, editors] }).inFlight).toEqual([]);
    const failed = uiReducer(sent, { type: "failed", id: "D-1", message: "conflict" });
    expect(currentDecision(failed)?.id).toBe("D-1");
    expect(failed.notice).toBe("conflict");
  });

  test("new decisions raise a notice (UI-05)", () => {
    expect(uiReducer(synced(lang), { type: "sync", decisions: [lang, note] }).notice).toBe(
      "1 new question",
    );
  });

  test("the decision on screen being withdrawn by Claude Code is announced", () => {
    const s = run(synced(lang), { type: "number", n: 2 });
    const gone = transitionDecision(lang, "cancelled", DISCONNECT_REASON, T1);
    const next = uiReducer(s, { type: "sync", decisions: [gone] });
    expect(next.notice).toContain("withdrew");
    expect(next.cursor).toBe(0);
  });

  test("answered on another screen is announced differently", () => {
    const elsewhere = answerDecision(lang, { selected: ["1"] }, undefined, T1).decision;
    expect(uiReducer(synced(lang), { type: "sync", decisions: [elsewhere] }).notice).toBe(
      "D-1 was answered elsewhere",
    );
  });
});

describe("Graph (T-314)", () => {
  test("lists every decision; Enter opens an answerable one, explains otherwise; u redoes a decided one", () => {
    const done = answerDecision(lang, { selected: ["1"] }, undefined, T1).decision;
    const waiting: Decision = { ...note, id: "D-4", status: "pending", dependsOn: [{ id: "D-9" }] };
    const graph = run(synced(done, editors, waiting), { type: "view", view: "graph" });
    expect(selectedDecision(graph)?.id).toBe("D-1"); // decided ones are listed too
    expect(run(graph, { type: "move", delta: 1 }, { type: "confirm" }).view).toBe("current");
    expect(run(graph, { type: "move", delta: 2 }, { type: "confirm" }).notice).toContain(
      "D-4 cannot be answered now",
    );
    expect(run(graph, { type: "revisit" }).outbox[0]).toMatchObject({
      type: "transition",
      id: "D-1",
      to: "revisit",
    });
  });
});

describe("Queue / History", () => {
  test("Tab cycles views; Enter in Queue focuses that decision", () => {
    const s = run(
      synced(lang, note),
      { type: "view" },
      { type: "move", delta: 1 },
      { type: "confirm" },
    );
    expect(s.view).toBe("current");
    expect(currentDecision(s)?.id).toBe("D-3");
    const tab = { type: "view" } as const;
    expect(run(synced(lang), tab, tab, tab).view).toBe("graph");
    expect(run(synced(lang), tab, tab, tab, tab).view).toBe("current");
  });

  test("revisit from History reopens and focuses the decision (UI-04 u)", () => {
    const decided = answerDecision(lang, { selected: ["1"] }, undefined, T1).decision;
    const s = run(synced(decided, note), { type: "view", view: "history" }, { type: "revisit" });
    expect(s.outbox[0]).toMatchObject({ type: "transition", id: "D-1", to: "revisit" });
    const reopened = transitionDecision(decided, "revisit", undefined, T1);
    const after = uiReducer({ ...s, outbox: [] }, { type: "sync", decisions: [reopened, note] });
    expect(after.view).toBe("current");
    expect(currentDecision(after)?.id).toBe("D-1");
  });
});
