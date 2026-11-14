import { describe, expect, test } from "bun:test";
import { answerDecision, createDecision } from "./decision";
import { type ExplorationResult, mergeExploration } from "./explore";

const T0 = "2026-11-14T00:00:00.000Z";
const T1 = "2026-11-14T00:01:00.000Z";

const base = () =>
  createDecision(
    {
      question: "Popup の技術は？",
      kind: "single",
      options: [
        { id: "tauri", label: "Tauri 2" },
        { id: "swiftui", label: "SwiftUI", recommended: true, reason: "old" },
      ],
    },
    "D-1",
    T0,
  );

const result = (extra: Partial<ExplorationResult> = {}): ExplorationResult => ({
  summary: "要点",
  tradeoffs: [],
  recommended: { optionId: "tauri", reason: "UI ロジックを共有できる" },
  newOptions: [],
  ...extra,
});

describe("mergeExploration (D5)", () => {
  test("moves the recommendation and bumps the version", () => {
    const d = mergeExploration(base(), result(), T1);
    expect(d.options).toEqual([
      { id: "tauri", label: "Tauri 2", recommended: true, reason: "UI ロジックを共有できる" },
      { id: "swiftui", label: "SwiftUI" },
    ]);
    expect(d).toMatchObject({ version: 2, updatedAt: T1 });
  });

  test("adds new options once, marked as Explorer proposals; can recommend one by label", () => {
    const d = mergeExploration(
      base(),
      result({
        newOptions: [
          { label: "Electron", description: "重い" },
          { label: "tauri 2", description: "duplicate" },
          { label: "Wails", description: "Go" },
        ],
        recommended: { optionId: "Wails", reason: "軽い" },
      }),
      T1,
    );
    expect(d.options.map((o) => [o.id, o.label, o.source, o.recommended])).toEqual([
      ["tauri", "Tauri 2", undefined, undefined],
      ["swiftui", "SwiftUI", undefined, undefined],
      ["x1", "Electron", "explorer", undefined],
      ["x2", "Wails", "explorer", true],
    ]);
    // A second Deep Dive keeps numbering.
    const again = mergeExploration(
      d,
      result({ newOptions: [{ label: "Qt", description: "" }] }),
      T1,
    );
    expect(again.options.at(-1)).toMatchObject({ id: "x3", label: "Qt" });
  });

  test("a free-text decision becomes single choice when options arrive", () => {
    const text = createDecision({ question: "同期方式は？", kind: "text" }, "D-2", T0);
    const d = mergeExploration(
      text,
      result({
        newOptions: [{ label: "CRDT", description: "" }],
        recommended: { optionId: "CRDT", reason: "r" },
      }),
      T1,
    );
    expect(d).toMatchObject({ kind: "single", allowOther: true });
    expect(d.options[0]).toMatchObject({ id: "x1", recommended: true });
  });

  test("a decision answered meanwhile keeps its options", () => {
    const decided = answerDecision(base(), { selected: ["swiftui"] }, undefined, T1).decision;
    expect(
      mergeExploration(decided, result({ newOptions: [{ label: "Qt", description: "" }] }), T1),
    ).toBe(decided);
  });
});
