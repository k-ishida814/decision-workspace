import { describe, expect, test } from "bun:test";
import type { PopupShow } from "@dw/protocol";
import {
  initialPopupState,
  type PopupUiAction,
  type PopupUiState,
  popupKey,
  popupReducer,
} from "./popup-ui";

const options = [
  { id: "1", label: "SQLite" },
  { id: "2", label: "Postgres" },
  { id: "3", label: "Cloud" },
];
const show = (over: Partial<PopupShow> = {}): PopupShow => ({
  type: "show",
  questions: [
    { id: "D-1", title: "", question: "DB?", kind: "single", allowOther: true, options },
    { id: "D-2", title: "", question: "Features?", kind: "multi", allowOther: false, options },
    { id: "D-3", title: "", question: "Name?", kind: "text", allowOther: true, options: [] },
  ],
  origin: { project: "p", at: "now" },
  more: 0,
  canWorkspace: false,
  ...over,
});

const run = (...actions: PopupUiAction[]): PopupUiState =>
  actions.reduce(popupReducer, popupReducer(initialPopupState, { type: "show", show: show() }));
const keys = (...k: string[]) => k.map((x) => popupKey(x) as PopupUiAction);

describe("popupReducer (T-603)", () => {
  test("one question at a time; the last one produces the answer message", () => {
    const s = run(
      ...keys("2", "Enter"), // single: Postgres
      ...keys("1", "3", "Enter"), // multi: toggle SQLite, Cloud
      { type: "confirm" }, // text: opens the field
      { type: "text", value: "  notes  " },
      { type: "confirm" },
    );
    expect(s.done).toEqual({
      type: "answer",
      answers: [
        { id: "D-1", selected: ["2"] },
        { id: "D-2", selected: ["1", "3"] },
        { id: "D-3", selected: [], text: "notes" },
      ],
    });
    expect(popupReducer(s, { type: "skip" })).toBe(s); // finished: nothing changes
  });

  test("own words on a choice question, skip, and the allowOther rule", () => {
    const s = run(
      ...keys("o"),
      { type: "text", value: "MySQL" },
      ...keys("Enter"), // D-1 in own words
      ...keys("o"), // D-2 does not allow other
    );
    expect(s.notice).toContain("does not take free text");
    expect(s.answers).toEqual([{ id: "D-1", selected: [], text: "MySQL" }]);
    const skipped = popupReducer(popupReducer(s, { type: "skip" }), { type: "skip" });
    expect(skipped.done?.type).toBe("answer");
    expect(skipped.answers.slice(1)).toEqual([
      { id: "D-2", skipped: true },
      { id: "D-3", skipped: true },
    ]);
  });

  test("clicks: single answers at once, multi toggles; j/k wrap", () => {
    const s = run(
      { type: "click", option: 2 },
      { type: "click", option: 0 },
      { type: "click", option: 1 },
    );
    expect(s.answers).toEqual([{ id: "D-1", selected: ["3"] }]);
    expect(s.picked).toEqual(["1", "2"]);
    expect(run(...keys("k")).cursor).toBe(2);
  });

  test("Esc / t: Claude Code's UI; w: Workspace only when one is open", () => {
    expect(run(...keys("Escape")).done).toEqual({ type: "fallback" });
    expect(run(...keys("t")).done).toEqual({ type: "fallback" });
    expect(run(...keys("w")).done).toBeUndefined();
    const open = popupReducer(initialPopupState, {
      type: "show",
      show: show({ canWorkspace: true }),
    });
    expect(popupReducer(open, { type: "toWorkspace" }).done).toEqual({ type: "toWorkspace" });
  });
});
