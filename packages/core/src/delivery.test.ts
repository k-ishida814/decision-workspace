import { expect, test } from "bun:test";
import type { Decision } from "@dw/protocol";
import { answerDecision, createDecision, transitionDecision } from "./decision";
import { formatDelivery } from "./delivery";

const T = "2026-11-14T00:00:00.000Z";
const options = [
  { id: "1", label: "ローカル" },
  { id: "2", label: "クラウド" },
];
const decided = (id: string, selected: string, rationale?: string, extra: Partial<Decision> = {}) =>
  answerDecision(
    {
      ...createDecision({ question: `${id}?`, title: `題${id}`, kind: "single", options }, id, T),
      ...extra,
    },
    { selected: [selected] },
    rationale,
    T,
  );

test("nothing new → no context", () => {
  expect(formatDelivery([], [])).toBeUndefined();
});

test("lists decisions with reasons, and the open count", () => {
  const a = decided("D-1", "2", "複数端末");
  const open = createDecision({ question: "Q?", kind: "text" }, "D-2", T);
  expect(formatDelivery([{ decision: a.decision }], [a.decision, open])).toBe(
    [
      "[Decision Workspace] Since your last message, the user decided the following. Follow these decisions.",
      "- D-1 題D-1 → クラウド (reason: 複数端末)",
      "Open decisions: 1 (the user is answering them in dw tui)",
    ].join("\n"),
  );
});

test("a changed answer shows the previous one and what is being re-checked", () => {
  const first = decided("D-1", "1");
  const reopened = transitionDecision(first.decision, "revisit", undefined, T);
  const second = answerDecision(reopened, { selected: ["2"] }, undefined, T);
  const child: Decision = {
    ...decided("D-2", "1").decision,
    status: "revisit",
    dependsOn: [{ id: "D-1" }],
  };
  const text = formatDelivery(
    [{ decision: second.decision, previous: first.revision }],
    [second.decision, child],
  );
  expect(text).toContain("- D-1 題D-1 → クラウド (changed; was: ローカル); re-checking: D-2");
});

test("caps items and characters; the rest is counted (NFR-06)", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    decision: decided(`D-${i + 1}`, "1").decision,
  }));
  const text =
    formatDelivery(
      many,
      many.map((m) => m.decision),
    ) ?? "";
  expect(text.split("\n").filter((l) => l.startsWith("- D-"))).toHaveLength(10);
  expect(text).toContain("and 4 more");
  expect(text).toContain("No open decisions.");
  const long = [{ decision: decided("D-1", "1", "x".repeat(3000)).decision }];
  expect(formatDelivery(long, [])).toContain("and 1 more");
});
