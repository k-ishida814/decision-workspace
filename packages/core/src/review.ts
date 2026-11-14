/**
 * Reviewer proposals (T-310, AG-03). Pure: checks what the agent proposed against the decisions
 * that exist, and turns an accepted "add" proposal into a new decision.
 */
import type { Decision, NewDecision, Proposal } from "@dw/protocol";
import { fromDrafts } from "./draft";

/** One item of the Reviewer's output (same shape as ReviewerOutput in agent-runner). */
export type ReviewItem = {
  kind: Proposal["kind"];
  title: string;
  reason: string;
  decisionIds: string[];
  question: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type ProposalDraft = Pick<Proposal, "kind" | "title" | "reason" | "decisionIds" | "draft">;

/**
 * Keep only proposals that can be applied: ids must exist (unknown ones are dropped), conflict /
 * revisit need at least one decided decision to reopen, add needs a question.
 */
export function proposalsFrom(
  items: readonly ReviewItem[],
  all: readonly Decision[],
): ProposalDraft[] {
  const byId = new Map(all.map((d) => [d.id, d]));
  const out: ProposalDraft[] = [];
  for (const item of items) {
    const known = [...new Set(item.decisionIds)].filter((id) => byId.has(id));
    if (item.kind === "add") {
      const question = item.question.trim();
      if (!question) continue;
      const usable = known.filter((id) => {
        const status = byId.get(id)?.status;
        return status !== "cancelled" && status !== "skipped";
      });
      out.push({
        kind: "add",
        title: item.title,
        reason: item.reason,
        decisionIds: usable,
        draft: {
          question,
          multiSelect: item.multiSelect,
          options: item.options.map((o) => ({
            label: o.label,
            description: o.description || undefined,
          })),
        },
      });
      continue;
    }
    const decided = known.filter((id) => byId.get(id)?.status === "decided");
    if (decided.length === 0) continue;
    out.push({ kind: item.kind, title: item.title, reason: item.reason, decisionIds: decided });
  }
  return out;
}

/** Decided decisions an accepted conflict / revisit proposal reopens (some may have moved on). */
export function toReopen(p: Proposal, all: readonly Decision[]): Decision[] {
  if (p.kind === "add") return [];
  return p.decisionIds
    .map((id) => all.find((d) => d.id === id))
    .filter((d): d is Decision => d?.status === "decided");
}

/** The decision an accepted "add" proposal creates, after its (still usable) prerequisites. */
export function fromAddProposal(p: Proposal, all: readonly Decision[]): NewDecision {
  if (p.kind !== "add" || !p.draft) throw new Error(`${p.id} does not add a decision`);
  const usable = p.decisionIds.filter((id) => {
    const status = all.find((d) => d.id === id)?.status;
    return status !== undefined && status !== "cancelled" && status !== "skipped";
  });
  const [draft] = fromDrafts(
    [
      {
        key: "new",
        title: p.title,
        question: p.draft.question,
        multiSelect: p.draft.multiSelect,
        options: p.draft.options,
        dependsOn: usable.map((ref) => ({ ref })),
      },
    ],
    new Map(),
    "claude",
  );
  const planId = /^P-\d+$/.test(p.target) ? p.target : undefined;
  return { ...(draft as NewDecision), key: undefined, origin: planId ? "plan" : "manual", planId };
}

/** Short label for a proposal kind. */
export function proposalKindLabel(kind: Proposal["kind"]): string {
  return kind === "conflict" ? "conflict" : kind === "revisit" ? "revisit" : "add";
}
