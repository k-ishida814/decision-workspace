/**
 * Popup UI state (T-603) as a pure reducer, like the Workspace's ui.ts. One question at a time;
 * when the last one is answered or skipped, `done` holds the message for the daemon. Keys match
 * the Workspace: digits / j k / Space / Enter / o / s, Esc for Claude Code's own UI.
 * The daemon validates the answers again; this only builds them.
 */
import type { PopupAnswer, PopupOut, PopupShow } from "@dw/protocol";

export type PopupUiState = {
  show?: PopupShow;
  index: number;
  cursor: number;
  /** Multi-select picks for the current question (option ids, in option order). */
  picked: string[];
  /** Typing an answer in one's own words. */
  editing: boolean;
  text: string;
  answers: PopupAnswer[];
  /** The final message; the Popup writes it and exits. */
  done?: Exclude<PopupOut, { type: "shown" }>;
  notice?: string;
};

export const initialPopupState: PopupUiState = {
  index: 0,
  cursor: 0,
  picked: [],
  editing: false,
  text: "",
  answers: [],
};

export type PopupUiAction =
  | { type: "show"; show: PopupShow }
  | { type: "move"; delta: number }
  | { type: "number"; n: number }
  | { type: "toggle" }
  | { type: "click"; option: number }
  | { type: "confirm" }
  | { type: "edit"; on: boolean }
  | { type: "text"; value: string }
  | { type: "skip" }
  | { type: "fallback" }
  | { type: "toWorkspace" };

export function currentQuestion(s: PopupUiState) {
  return s.show?.questions[s.index];
}

const fresh = { cursor: 0, picked: [] as string[], editing: false, text: "", notice: undefined };

function record(s: PopupUiState, answer: PopupAnswer): PopupUiState {
  const answers = [...s.answers, answer];
  const total = s.show?.questions.length ?? 0;
  if (s.index + 1 >= total) return { ...s, ...fresh, answers, done: { type: "answer", answers } };
  return { ...s, ...fresh, answers, index: s.index + 1 };
}

export function popupReducer(s: PopupUiState, a: PopupUiAction): PopupUiState {
  if (s.done) return s; // finished: ignore anything else
  if (a.type === "show") return { ...initialPopupState, show: a.show };
  const q = currentQuestion(s);
  if (!q) return s;
  const count = q.options.length;

  switch (a.type) {
    case "move":
      if (count === 0) return s;
      return { ...s, cursor: (s.cursor + a.delta + count) % count };
    case "number": {
      const i = a.n - 1;
      if (i < 0 || i >= count) return s;
      const moved = { ...s, cursor: i };
      return q.kind === "multi" ? popupReducer(moved, { type: "toggle" }) : moved;
    }
    case "toggle": {
      if (q.kind !== "multi") return s;
      const id = q.options[s.cursor]?.id;
      if (!id) return s;
      const picked = s.picked.includes(id) ? s.picked.filter((p) => p !== id) : [...s.picked, id];
      const order = q.options.map((o) => o.id);
      return { ...s, picked: picked.sort((x, y) => order.indexOf(x) - order.indexOf(y)) };
    }
    case "click": {
      // A click chooses: single answers at once, multi toggles.
      const moved = { ...s, cursor: a.option };
      return q.kind === "multi"
        ? popupReducer(moved, { type: "toggle" })
        : popupReducer(moved, { type: "confirm" });
    }
    case "confirm": {
      if (s.editing || q.kind === "text") {
        const text = s.text.trim();
        if (!text) return q.kind === "text" ? { ...s, editing: true } : { ...s, editing: false };
        return record(s, { id: q.id, selected: [], text });
      }
      const id = q.options[s.cursor]?.id;
      const selected = q.kind === "multi" && s.picked.length > 0 ? s.picked : id ? [id] : [];
      return selected.length > 0 ? record(s, { id: q.id, selected }) : s;
    }
    case "edit":
      if (a.on && !q.allowOther && q.kind !== "text") {
        return { ...s, notice: "This question does not take free text" };
      }
      return { ...s, editing: a.on, notice: undefined };
    case "text":
      return { ...s, text: a.value };
    case "skip":
      return record(s, { id: q.id, skipped: true });
    case "fallback":
      return { ...s, done: { type: "fallback" } };
    case "toWorkspace":
      if (!s.show?.canWorkspace) return { ...s, notice: "No Workspace is open for this project" };
      return { ...s, done: { type: "toWorkspace" } };
  }
}

/** Keyboard → action, outside the text field. Matches the Workspace TUI where it can. */
export function popupKey(key: string): PopupUiAction | undefined {
  if (/^[1-9]$/.test(key)) return { type: "number", n: Number(key) };
  switch (key) {
    case "ArrowDown":
    case "j":
      return { type: "move", delta: 1 };
    case "ArrowUp":
    case "k":
      return { type: "move", delta: -1 };
    case " ":
      return { type: "toggle" };
    case "Enter":
      return { type: "confirm" };
    case "o":
      return { type: "edit", on: true };
    case "s":
      return { type: "skip" };
    case "w":
      return { type: "toWorkspace" };
    case "t":
    case "Escape":
      return { type: "fallback" };
  }
  return undefined;
}
