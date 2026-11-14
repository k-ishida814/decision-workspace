import { describe, expect, test } from "bun:test";
import { Answer, DwEvent, methods, NewDecision } from "./index";

describe("schemas reject invalid input", () => {
  test("Answer needs a selection or non-empty text", () => {
    expect(Answer.safeParse({ selected: [] }).success).toBe(false);
    expect(Answer.safeParse({ selected: [], text: "  " }).success).toBe(false);
    expect(Answer.safeParse({ selected: ["a"] }).success).toBe(true);
    expect(Answer.safeParse({ text: "free" }).success).toBe(true);
  });

  test("NewDecision requires a question and a known kind", () => {
    expect(NewDecision.safeParse({ question: "", kind: "single" }).success).toBe(false);
    expect(NewDecision.safeParse({ question: "Q?", kind: "rank" }).success).toBe(false);
    expect(NewDecision.parse({ question: "Q?", kind: "text" })).toMatchObject({
      title: "",
      allowOther: true,
      options: [],
    });
  });

  test("method params are validated", () => {
    const answer = methods["decision.answer"].params;
    expect(
      answer.safeParse({
        project: "/p",
        id: "D-1",
        expectedVersion: 0,
        answer: { selected: ["a"] },
      }).success,
    ).toBe(false);
    const ask = methods["decision.askBatch"].params;
    expect(ask.safeParse({ project: "/p", batchId: "t", questions: [] }).success).toBe(false);
  });

  test("events carry a full decision", () => {
    expect(
      DwEvent.safeParse({ type: "decision.created", project: "/p", decision: {} }).success,
    ).toBe(false);
  });
});
