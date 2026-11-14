import { expect, test } from "bun:test";
import type { Decision, DecisionStatus, Dependency } from "@dw/protocol";
import { overviewMermaid, overviewRows, overviewText } from "./overview";

const T = "2026-11-14T00:00:00.000Z";
const d = (
  id: string,
  title: string,
  status: DecisionStatus,
  extra: Partial<Decision> & { dependsOn?: Dependency[] } = {},
): Decision => ({
  id,
  origin: "plan",
  planId: "P-1",
  dependsOn: [],
  title,
  question: `${title}は？`,
  kind: "single",
  allowOther: true,
  options: [
    { id: "1", label: "ローカル" },
    { id: "2", label: "クラウド" },
  ],
  status,
  held: false,
  version: 1,
  revision: status === "decided" ? 1 : 0,
  createdAt: T,
  updatedAt: T,
  ...extra,
});

// D-1 保存先 = ローカル
//   D-2 同期方式 (only for クラウド) → skipped by condition
//     D-3 競合解決 → skipped (prerequisite closed)
//   D-4 DB → ready
//     D-5 移行 (also after D-6) → pending
// D-6 バックアップ → decided "週1 \"差分\""
// D-7 (no plan)
const all: Decision[] = [
  d("D-1", "保存先", "decided", { answer: { selected: ["1"] } }),
  d("D-2", "同期方式", "skipped", {
    closedReason: "condition-unmet",
    dependsOn: [{ id: "D-1", whenOptions: ["2"] }],
  }),
  d("D-3", "競合解決", "skipped", {
    closedReason: "prerequisite-closed",
    dependsOn: [{ id: "D-2" }],
  }),
  d("D-4", "DB", "ready", { dependsOn: [{ id: "D-1" }] }),
  d("D-5", "移行", "pending", { dependsOn: [{ id: "D-4" }, { id: "D-6" }] }),
  d("D-6", "バックアップ", "decided", { answer: { selected: [], text: '週1 "差分"' } }),
  d("D-7", "ロゴ", "ready", { planId: undefined, origin: "manual" }),
];
const plans = [{ id: "P-1", request: "同期機能の設計" }];

test("rows: one tree per plan, nested under the first prerequisite, plan-less last", () => {
  expect(overviewRows(all).map((r) => [r.decision.id, r.depth, r.planHeader ?? null])).toEqual([
    ["D-1", 0, "P-1"],
    ["D-2", 1, null],
    ["D-3", 2, null],
    ["D-4", 1, null],
    ["D-5", 2, null],
    ["D-6", 0, null],
    ["D-7", 0, ""],
  ]);
  expect(overviewRows(all, "P-1")).toHaveLength(6);
});

test("text tree shows answers, conditions, closed branches and extra prerequisites", () => {
  expect(overviewText(all, plans)).toBe(
    [
      "P-1 同期機能の設計",
      "├─ D-1 [decided] 保存先 → ローカル",
      "│  ├─ D-2 [skipped: condition-unmet] 同期方式  (when D-1 = クラウド)",
      "│  │  └─ D-3 [skipped: prerequisite-closed] 競合解決",
      "│  └─ D-4 [ready] DB",
      "│     └─ D-5 [pending] 移行  (also after D-6)",
      '└─ D-6 [decided] バックアップ → 週1 "差分"',
      "",
      "(no plan)",
      "└─ D-7 [ready] ロゴ",
    ].join("\n"),
  );
  expect(overviewText(all, plans, "P-9")).toBe("no decisions in P-9");
});

test("mermaid: subgraphs, an edge per dependency with condition labels, escaped text", () => {
  const m = overviewMermaid(all, plans);
  expect(m.split("\n")[0]).toBe("flowchart TD");
  expect(m).toContain('  subgraph P1["P-1 同期機能の設計"]');
  expect(m).toContain('    D1["D-1 保存先<br/>→ ローカル"]:::decided');
  expect(m).toContain('    D6["D-6 バックアップ<br/>→ 週1 #quot;差分#quot;"]:::decided');
  expect(m).toContain('  D7["D-7 ロゴ"]:::ready'); // outside any subgraph
  expect(m).toContain('  D1 -- "クラウド" --> D2');
  expect(m).toContain("  D4 --> D5");
  expect(m).toContain("  D6 --> D5");
  expect(m).toContain("  classDef skipped ");
  expect(m).not.toContain("classDef cancelled"); // only classes in use
  // Every subgraph is closed.
  expect(m.match(/subgraph /g)?.length).toBe(m.match(/^ {2}end$/gm)?.length);
});
