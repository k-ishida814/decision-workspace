import { describe, expect, test } from "bun:test";
import type { Decision, Proposal } from "@dw/protocol";
import { createDecision } from "./decision";
import { fromAddProposal, proposalsFrom, type ReviewItem, toReopen } from "./review";

const NOW = "2026-11-14T00:00:00.000Z";

function decision(id: string, status: Decision["status"]): Decision {
  const d = createDecision({ question: `${id}?`, kind: "text" }, id, NOW);
  return { ...d, status };
}

const all = [decision("D-1", "decided"), decision("D-2", "decided"), decision("D-3", "skipped")];

const item = (over: Partial<ReviewItem>): ReviewItem => ({
  kind: "conflict",
  title: "t",
  reason: "r",
  decisionIds: [],
  question: "",
  multiSelect: false,
  options: [],
  ...over,
});

describe("proposalsFrom", () => {
  test("drops unknown ids and proposals with nothing to reopen", () => {
    const out = proposalsFrom(
      [
        item({ decisionIds: ["D-1", "D-9", "D-2", "D-1"] }),
        item({ kind: "revisit", decisionIds: ["D-3"] }), // skipped: nothing decided to reopen
        item({ kind: "revisit", decisionIds: ["D-9"] }),
      ],
      all,
    );
    expect(out).toEqual([
      { kind: "conflict", title: "t", reason: "r", decisionIds: ["D-1", "D-2"] },
    ]);
  });

  test("add keeps a draft and only usable prerequisites; empty question is dropped", () => {
    const out = proposalsFrom(
      [
        item({
          kind: "add",
          question: " 認証は？ ",
          decisionIds: ["D-1", "D-3"],
          options: [{ label: "OAuth", description: "" }],
        }),
        item({ kind: "add", question: "  " }),
      ],
      all,
    );
    expect(out).toEqual([
      {
        kind: "add",
        title: "t",
        reason: "r",
        decisionIds: ["D-1"],
        draft: {
          question: "認証は？",
          multiSelect: false,
          options: [{ label: "OAuth", description: undefined }],
        },
      },
    ]);
  });
});

const proposal = (over: Partial<Proposal>): Proposal => ({
  id: "RV-1",
  runId: "R-1",
  target: "project",
  kind: "conflict",
  title: "t",
  reason: "r",
  decisionIds: ["D-1", "D-2"],
  status: "open",
  createdAt: NOW,
  ...over,
});

test("toReopen: only decisions still decided", () => {
  const changed = [decision("D-1", "revisit"), decision("D-2", "decided")];
  expect(toReopen(proposal({}), changed).map((d) => d.id)).toEqual(["D-2"]);
  expect(toReopen(proposal({ kind: "add" }), changed)).toEqual([]);
});

test("fromAddProposal: new decision after its prerequisites, in the reviewed plan", () => {
  const p = proposal({
    kind: "add",
    target: "P-2",
    title: "認証",
    decisionIds: ["D-1", "D-3"],
    draft: {
      question: "認証は？",
      multiSelect: true,
      options: [{ label: "OAuth" }, { label: "Passkey" }],
    },
  });
  const d = fromAddProposal(p, all);
  expect(d).toMatchObject({
    title: "認証",
    question: "認証は？",
    kind: "multi",
    origin: "plan",
    planId: "P-2",
    dependsOn: [{ ref: "D-1" }],
  });
  expect(d.options?.map((o) => o.id)).toEqual(["1", "2"]);
  expect(fromAddProposal({ ...p, target: "project" }, all)).toMatchObject({ origin: "manual" });
});
