/** Applying a Deep Dive result to a decision (T-308, design D5). Pure. */
import type { Decision, Option } from "@dw/protocol";
import { isOpen } from "./decision";

export type ExplorationResult = {
  summary: string;
  tradeoffs: { optionId: string; pros: string[]; cons: string[] }[];
  recommended: { optionId: string; reason: string };
  newOptions: { label: string; description: string }[];
};

/**
 * Mark the recommendation and add proposed options. Existing options are never removed or
 * renamed (AskUserQuestion answers must keep Claude's labels). A decision that is no longer open
 * keeps its options; the result is only kept as history.
 */
export function mergeExploration(d: Decision, x: ExplorationResult, now: string): Decision {
  if (!isOpen(d)) return d;
  const normalize = (s: string) => s.trim().toLowerCase();
  const known = new Set(d.options.map((o) => normalize(o.label)));
  let next = d.options.filter((o) => o.source === "explorer").length;
  const added: Option[] = [];
  for (const o of x.newOptions) {
    if (!o.label.trim() || known.has(normalize(o.label))) continue;
    known.add(normalize(o.label));
    next++;
    added.push({
      id: `x${next}`,
      label: o.label.trim(),
      description: o.description,
      source: "explorer",
    });
  }
  const options = [...d.options, ...added];
  const pick =
    options.find((o) => o.id === x.recommended.optionId) ??
    options.find((o) => normalize(o.label) === normalize(x.recommended.optionId));
  const marked = options.map((o) => {
    const { recommended: _r, reason: _why, ...rest } = o;
    return o.id === pick?.id ? { ...rest, recommended: true, reason: x.recommended.reason } : rest;
  });
  return {
    ...d,
    options: marked,
    // A free-text decision that now has options can be answered by picking one.
    kind: d.kind === "text" && marked.length > 0 ? "single" : d.kind,
    allowOther: d.kind === "text" ? true : d.allowOther,
    version: d.version + 1,
    updatedAt: now,
  };
}
