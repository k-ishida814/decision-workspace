/** Where a batch of questions from Claude Code goes (T-602, design/ui-modes.md §3). Pure. */
import type { Decision, PopupShow, UiMode } from "@dw/protocol";

export type Route = "workspace" | "popup" | "fallback";

/** Workspace → Popup → Claude Code's own UI ("fallback"). */
export function routeFor(mode: UiMode, workspaceWatching: boolean): Route {
  switch (mode) {
    case "off":
      return "fallback";
    case "workspace":
      return workspaceWatching ? "workspace" : "fallback";
    case "popup":
      return "popup";
    case "auto":
      return workspaceWatching ? "workspace" : "popup";
  }
}

/** The `show` message for a batch (its open decisions, in question order). */
export function popupShow(
  batch: readonly Decision[],
  origin: { project: string; session?: string; at: string },
  more: number,
  canWorkspace: boolean,
): PopupShow | undefined {
  const open = batch
    .filter((d) => d.status === "ready" || d.status === "revisit")
    .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
  if (open.length === 0) return undefined;
  return {
    type: "show",
    questions: open.map((d) => ({
      id: d.id,
      title: d.title,
      question: d.question,
      kind: d.kind,
      allowOther: d.allowOther,
      options: d.options,
    })),
    origin,
    more,
    canWorkspace,
  };
}
