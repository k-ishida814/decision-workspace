import { describe, expect, test } from "bun:test";
import type { Decision } from "@dw/protocol";
import {
  answerDecision,
  answerText,
  batchOutcome,
  createDecision,
  DomainError,
  FALLBACK_REASON,
  fromAskQuestions,
  holdDecision,
  queueOrder,
  SKIPPED_ANSWER,
  transitionDecision,
} from "./decision";

const T0 = "2026-11-13T00:00:00.000Z";
const T1 = "2026-11-13T00:01:00.000Z";

const single = () =>
  createDecision(
    {
      question: "DB?",
      kind: "single",
      options: [
        { id: "a", label: "SQLite" },
        { id: "b", label: "Postgres" },
      ],
    },
    "D-1",
    T0,
  );

const multi = () =>
  createDecision(
    {
      question: "Editors?",
      kind: "multi",
      allowOther: false,
      options: [
        { id: "1", label: "VS Code" },
        { id: "2", label: "Neovim" },
      ],
    },
    "D-2",
    T0,
  );

function expectDomainError(fn: () => unknown, code: DomainError["code"]) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return;
  }
  throw new Error("expected DomainError");
}

describe("createDecision", () => {
  test("starts ready, version 1, never answered", () => {
    const d = single();
    expect(d).toMatchObject({
      status: "ready",
      version: 1,
      revision: 0,
      held: false,
      allowOther: true,
    });
  });
});

describe("answerDecision", () => {
  test("decides and records revision 1 (DQ-04)", () => {
    const { decision, revision } = answerDecision(single(), { selected: ["a"] }, "offline", T1);
    expect(decision).toMatchObject({
      status: "decided",
      revision: 1,
      version: 2,
      rationale: "offline",
    });
    expect(revision).toEqual({
      decisionId: "D-1",
      revision: 1,
      answer: { selected: ["a"] },
      rationale: "offline",
      createdAt: T1,
    });
  });

  test("re-answering goes through revisit and keeps counting revisions (DQ-05)", () => {
    const first = answerDecision(single(), { selected: ["a"] }, undefined, T1).decision;
    const revisit = transitionDecision(first, "revisit", undefined, T1);
    expect(revisit.answer).toEqual({ selected: ["a"] }); // previous answer still visible
    const second = answerDecision(revisit, { selected: ["b"] }, undefined, T1);
    expect(second.revision.revision).toBe(2);
    expect(second.decision.version).toBe(4);
  });

  test("cannot answer a decided decision directly", () => {
    const decided = answerDecision(single(), { selected: ["a"] }, undefined, T1).decision;
    expectDomainError(
      () => answerDecision(decided, { selected: ["b"] }, undefined, T1),
      "InvalidTransition",
    );
  });

  test("validates the answer against the decision", () => {
    expectDomainError(
      () => answerDecision(single(), { selected: ["zzz"] }, undefined, T1),
      "InvalidAnswer",
    );
    expectDomainError(
      () => answerDecision(single(), { selected: ["a", "b"] }, undefined, T1),
      "InvalidAnswer",
    );
    expectDomainError(
      () => answerDecision(single(), { selected: [] }, undefined, T1),
      "InvalidAnswer",
    );
    expectDomainError(
      () => answerDecision(multi(), { selected: [], text: "Zed" }, undefined, T1),
      "InvalidAnswer",
    );
    expect(answerDecision(multi(), { selected: ["1", "2"] }, undefined, T1).decision.status).toBe(
      "decided",
    );
  });

  test("single choice plus a free-text note (DQ-02)", () => {
    const d = answerDecision(
      single(),
      { selected: ["a"], text: " WAL mode " },
      undefined,
      T1,
    ).decision;
    expect(d.answer).toEqual({ selected: ["a"], text: "WAL mode" });
    expect(answerText(d)).toBe("SQLite (WAL mode)");
  });
});

describe("transitionDecision", () => {
  test("skip records the reason; cancelled is terminal", () => {
    const skipped = transitionDecision(single(), "skipped", "not needed", T1);
    expect(skipped).toMatchObject({ status: "skipped", closedReason: "not needed", version: 2 });
    const cancelled = transitionDecision(single(), "cancelled", undefined, T1);
    expectDomainError(
      () => transitionDecision(cancelled, "ready", undefined, T1),
      "InvalidTransition",
    );
  });

  test("decided can only be reached by answering", () => {
    expectDomainError(
      () => transitionDecision(single(), "decided", undefined, T1),
      "InvalidTransition",
    );
  });
});

describe("queueOrder", () => {
  test("open decisions only; held ones last; then by creation and batch order", () => {
    const at = (id: string, createdAt: string, batchIndex?: number): Decision => ({
      ...single(),
      id,
      createdAt,
      batchIndex,
    });
    const held = holdDecision(at("D-1", T0), true, T1);
    const b1 = at("D-3", T1, 1);
    const b0 = at("D-2", T1, 0);
    const done = answerDecision(at("D-4", T0), { selected: ["a"] }, undefined, T1).decision;
    expect(queueOrder([held, b1, done, b0]).map((d) => d.id)).toEqual(["D-2", "D-3", "D-1"]);
  });
});

describe("AskUserQuestion bridge", () => {
  const questions = [
    { question: "Lang?", header: "Lang", options: [{ label: "TS" }, { label: "Rust" }] },
    { question: "Editors?", multiSelect: true, options: [{ label: "VS Code" }, { label: "Zed" }] },
  ];
  const decisions = () =>
    fromAskQuestions(questions, "toolu_1", "s1").map((n, i) => createDecision(n, `D-${i + 1}`, T0));

  test("one decision per question, multiSelect → multi, free text allowed", () => {
    const [lang, editors] = decisions();
    expect(lang).toMatchObject({
      kind: "single",
      title: "Lang",
      batchId: "toolu_1",
      batchIndex: 0,
      allowOther: true,
    });
    expect(editors?.kind).toBe("multi");
    expect(editors?.options.map((o) => o.id)).toEqual(["1", "2"]);
  });

  test("batch is answered only when every question is decided, keyed by question text", () => {
    const [lang, editors] = decisions() as [Decision, Decision];
    const langDone = answerDecision(lang, { selected: ["2"] }, undefined, T1).decision;
    expect(batchOutcome([langDone, editors])).toBeUndefined();
    const editorsDone = answerDecision(editors, { selected: ["1", "2"] }, undefined, T1).decision;
    expect(batchOutcome([langDone, editorsDone])).toEqual({
      status: "answered",
      answers: { "Lang?": "Rust", "Editors?": "VS Code, Zed" },
    });
  });

  test("fallback and cancel end the batch", () => {
    const [lang, editors] = decisions() as [Decision, Decision];
    const fb = transitionDecision(lang, "cancelled", FALLBACK_REASON, T1);
    expect(batchOutcome([fb, editors])).toEqual({ status: "fallback" });
    const cancelled = transitionDecision(lang, "cancelled", "user", T1);
    expect(batchOutcome([cancelled, editors])).toEqual({ status: "cancelled" });
  });

  test("a skipped question is answered with an instruction; the rest keep their answers", () => {
    const [lang, editors] = decisions() as [Decision, Decision];
    const skipped = transitionDecision(lang, "skipped", "user", T1);
    expect(batchOutcome([skipped, editors])).toBeUndefined(); // still waiting for Editors?
    const editorsDone = answerDecision(editors, { selected: ["2"] }, undefined, T1).decision;
    expect(batchOutcome([skipped, editorsDone])).toEqual({
      status: "answered",
      answers: { "Lang?": SKIPPED_ANSWER, "Editors?": "Zed" },
    });
  });
});
