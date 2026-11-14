/**
 * Messages between the daemon and the Popup (T-602, design/ui-modes.md §4.5). One JSON object per
 * line: the daemon writes `show` to the Popup's stdin; the Popup writes `shown` once it is on
 * screen, then exactly one final message (answer / fallback / toWorkspace) to stdout and exits.
 */
import { z } from "zod";
import { DecisionId, InputKind, Option } from "./decision";

export const PopupQuestion = z.object({
  id: DecisionId,
  title: z.string(),
  question: z.string(),
  kind: InputKind,
  allowOther: z.boolean(),
  options: z.array(Option),
});
export type PopupQuestion = z.infer<typeof PopupQuestion>;

export const PopupShow = z.object({
  type: z.literal("show"),
  questions: z.array(PopupQuestion).min(1),
  origin: z.object({
    /** Project folder name. */
    project: z.string(),
    /** Short Claude Code session id, if known. */
    session: z.string().optional(),
    /** When the question arrived (ISO). */
    at: z.string(),
  }),
  /** Questions waiting after this one. */
  more: z.number().int().nonnegative(),
  /** A Workspace (TUI) watches this project, so "consider in Workspace" can be offered. */
  canWorkspace: z.boolean(),
});
export type PopupShow = z.infer<typeof PopupShow>;

export const PopupAnswer = z.union([
  z.object({
    id: DecisionId,
    selected: z.array(z.string()),
    text: z.string().optional(),
  }),
  z.object({ id: DecisionId, skipped: z.literal(true) }),
]);
export type PopupAnswer = z.infer<typeof PopupAnswer>;

export const PopupOut = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shown") }).passthrough(),
  z.object({ type: z.literal("answer"), answers: z.array(PopupAnswer).min(1) }),
  /** Answer in Claude Code's own UI instead (close button, Esc). */
  z.object({ type: z.literal("fallback") }),
  /** Leave the questions to the Workspace; the hook keeps waiting. */
  z.object({ type: z.literal("toWorkspace") }),
]);
export type PopupOut = z.infer<typeof PopupOut>;
