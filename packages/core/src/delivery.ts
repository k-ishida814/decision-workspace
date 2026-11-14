/** What Claude is told about new decisions on the next prompt (T-312, CC-07, NFR-06). Pure. */
import type { Decision, Revision } from "@dw/protocol";
import { answerText, isOpen } from "./decision";

export const DELIVERY_LIMITS = { items: 10, chars: 2000 } as const;

function revisionText(d: Decision, r: Revision): string {
  const labels = r.answer.selected.map((id) => d.options.find((o) => o.id === id)?.label ?? id);
  return [labels.join(", "), r.answer.text].filter(Boolean).join(" / ");
}

/**
 * One block of context, or undefined when there is nothing new. Each item is one line:
 * the decision, its answer and reason, and for a changed answer the previous one and which
 * decisions now need re-checking.
 */
export function formatDelivery(
  items: readonly { decision: Decision; previous?: Revision }[],
  all: readonly Decision[],
  limits: { items: number; chars: number } = DELIVERY_LIMITS,
): string | undefined {
  if (items.length === 0) return undefined;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const { decision: d, previous } of items) {
    const title = d.title || d.question;
    let line = `- ${d.id} ${title} → ${answerText(d)}`;
    if (d.rationale) line += ` (reason: ${d.rationale})`;
    if (previous) {
      line += ` (changed; was: ${revisionText(d, previous)})`;
      const affected = all.filter(
        (x) => x.dependsOn.some((dep) => dep.id === d.id) && x.status === "revisit",
      );
      if (affected.length > 0) line += `; re-checking: ${affected.map((x) => x.id).join(", ")}`;
    }
    if (shown >= limits.items || used + line.length > limits.chars) break;
    lines.push(line);
    used += line.length;
    shown++;
  }
  const rest = items.length - shown;
  const open = all.filter(isOpen).length;
  return [
    "[Decision Workspace] Since your last message, the user decided the following. Follow these decisions.",
    ...lines,
    ...(rest > 0 ? [`and ${rest} more (decision_list with status: "decided")`] : []),
    open > 0
      ? `Open decisions: ${open} (the user is answering them in dw tui)`
      : "No open decisions.",
  ].join("\n");
}
