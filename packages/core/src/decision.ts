/**
 * Decision domain logic. Pure functions: the caller supplies ids and timestamps, so this stays
 * runtime-neutral (ADR-0001) and deterministic in tests.
 */
import {
  type Answer,
  Answer as AnswerSchema,
  type AskBatchResult,
  type AskQuestion,
  type Decision,
  type DecisionStatus,
  type NewDecision,
  NewDecision as NewDecisionSchema,
  type Revision,
} from "@dw/protocol";
import { isActionable } from "./graph";
import { canTransition } from "./status";

export type DomainErrorCode = "InvalidTransition" | "InvalidAnswer";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Statuses the user still has to act on, in queue order. */
export const OPEN_STATUSES: readonly DecisionStatus[] = [
  "ready",
  "revisit",
  "pending",
  "exploring",
];

export function isOpen(d: Decision): boolean {
  return OPEN_STATUSES.includes(d.status);
}

export function createDecision(input: NewDecision, id: string, now: string): Decision {
  const n = NewDecisionSchema.parse(input);
  return {
    id,
    origin: n.origin,
    planId: n.planId,
    // Refs are resolved to ids by the store (createDecisions); this is the single-decision path.
    dependsOn: n.dependsOn.map((d) => ({ id: d.ref, whenOptions: d.whenOptions })),
    batchId: n.batchId,
    batchIndex: n.batchIndex,
    sessionId: n.sessionId,
    title: n.title,
    question: n.question,
    kind: n.kind,
    allowOther: n.kind === "text" ? true : n.allowOther,
    options: n.options,
    // Phase 1 has no Explorer agent, so a new decision is ready to answer right away.
    status: "ready",
    held: false,
    version: 1,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateAnswer(d: Decision, raw: Answer): Answer {
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success)
    throw new DomainError("InvalidAnswer", parsed.error.issues[0]?.message ?? "invalid answer");
  const answer = parsed.data;
  const text = answer.text?.trim();
  const ids = new Set(d.options.map((o) => o.id));
  const unknown = answer.selected.filter((s) => !ids.has(s));
  if (unknown.length > 0)
    throw new DomainError("InvalidAnswer", `unknown option: ${unknown.join(", ")}`);
  if (new Set(answer.selected).size !== answer.selected.length) {
    throw new DomainError("InvalidAnswer", "duplicate option");
  }
  if (d.kind === "text" && answer.selected.length > 0) {
    throw new DomainError("InvalidAnswer", "this decision takes free text only");
  }
  if (d.kind === "single" && answer.selected.length > 1) {
    throw new DomainError("InvalidAnswer", "only one option can be selected");
  }
  if (text && !d.allowOther)
    throw new DomainError("InvalidAnswer", "free text is not allowed here");
  return text ? { selected: answer.selected, text } : { selected: answer.selected };
}

/** Record an answer. Returns the updated decision and the new revision (DQ-04, DQ-05). */
export function answerDecision(
  d: Decision,
  raw: Answer,
  rationale: string | undefined,
  now: string,
): { decision: Decision; revision: Revision } {
  if (d.status !== "ready" && d.status !== "revisit") {
    throw new DomainError("InvalidTransition", `cannot answer a decision in status "${d.status}"`);
  }
  const answer = validateAnswer(d, raw);
  const revisionNo = d.revision + 1;
  const decision: Decision = {
    ...d,
    status: "decided",
    answer,
    rationale,
    revision: revisionNo,
    version: d.version + 1,
    held: false,
    updatedAt: now,
  };
  return {
    decision,
    revision: { decisionId: d.id, revision: revisionNo, answer, rationale, createdAt: now },
  };
}

/** Change status without answering (skip, cancel, revisit, …). Answering goes through answerDecision. */
export function transitionDecision(
  d: Decision,
  to: DecisionStatus,
  reason: string | undefined,
  now: string,
): Decision {
  if (to === "decided") throw new DomainError("InvalidTransition", "use answer to decide");
  if (!canTransition(d.status, to)) {
    throw new DomainError("InvalidTransition", `cannot change "${d.status}" to "${to}"`);
  }
  const closing = to === "skipped" || to === "cancelled";
  return {
    ...d,
    status: to,
    closedReason: closing ? reason : undefined,
    held: closing ? false : d.held,
    version: d.version + 1,
    updatedAt: now,
  };
}

export function holdDecision(d: Decision, held: boolean, now: string): Decision {
  if (!isOpen(d))
    throw new DomainError("InvalidTransition", `cannot hold a "${d.status}" decision`);
  return { ...d, held, version: d.version + 1, updatedAt: now };
}

/**
 * Open decisions in the order the user should see them: answerable now, then waiting on a
 * prerequisite (DG-06); within each, not held first, then oldest first.
 */
export function queueOrder(decisions: readonly Decision[]): Decision[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const waiting = (d: Decision) => Number(!isActionable(d, byId));
  return decisions
    .filter(isOpen)
    .sort(
      (a, b) =>
        waiting(a) - waiting(b) ||
        Number(a.held) - Number(b.held) ||
        a.createdAt.localeCompare(b.createdAt) ||
        (a.batchIndex ?? 0) - (b.batchIndex ?? 0) ||
        idNumber(a.id) - idNumber(b.id),
    );
}

export function idNumber(id: string): number {
  return Number(id.slice(2));
}

export function formatId(n: number): string {
  return `D-${n}`;
}

// --- Claude Code AskUserQuestion bridge -------------------------------------------------------

/** Turn one AskUserQuestion call into decisions, one per question. */
export function fromAskQuestions(
  questions: readonly AskQuestion[],
  batchId: string,
  sessionId: string | undefined,
): NewDecision[] {
  return questions.map((q, i) => {
    const options = (q.options ?? []).map((o, j) => ({
      id: String(j + 1),
      label: o.label,
      description: o.description,
    }));
    return {
      origin: "ask",
      batchId,
      batchIndex: i,
      sessionId,
      title: q.header ?? "",
      question: q.question,
      kind: options.length === 0 ? "text" : q.multiSelect ? "multi" : "single",
      // AskUserQuestion always offers "Type something", so free text is allowed.
      allowOther: true,
      options,
    };
  });
}

/**
 * The answer string Claude Code expects: option labels joined with ", " (confirmed in S-01),
 * or the free text. A selection plus a note becomes "Label (note)".
 */
export function answerText(d: Decision): string {
  const answer = d.answer;
  if (!answer) return "";
  const labels = answer.selected
    .map((id) => d.options.find((o) => o.id === id)?.label)
    .filter((l): l is string => Boolean(l))
    .join(", ");
  if (labels && answer.text) return `${labels} (${answer.text})`;
  return labels || answer.text || "";
}

export const FALLBACK_REASON = "fallback";
/** Recorded when the hook waiting on a batch goes away (Esc / timeout in Claude Code). */
export const DISCONNECT_REASON = "hook-disconnected";
/** Recorded when no UI is watching the project, so nobody could answer (hand back to Claude Code). */
export const NO_VIEWER_REASON = "no-viewer";

const HAND_BACK = new Set([FALLBACK_REASON, NO_VIEWER_REASON]);

/**
 * Sent to Claude as the "answer" of a question the user skipped. Delivered as a normal answer
 * (not a deny) so Claude Code shows no error and the other answers of the batch still arrive.
 */
export const SKIPPED_ANSWER =
  "(No answer: the user skipped this question. Do not ask it again; proceed with a reasonable default and state the assumption you made.)";

/** What to return to a waiting hook, or undefined while the batch is still open. */
export function batchOutcome(decisions: readonly Decision[]): AskBatchResult | undefined {
  if (decisions.some((d) => d.closedReason && HAND_BACK.has(d.closedReason))) {
    return { status: "fallback" };
  }
  // Cancelled by the user (not a hand-back): the whole call is withdrawn.
  if (decisions.some((d) => d.status === "cancelled")) return { status: "cancelled" };
  if (
    decisions.length === 0 ||
    !decisions.every((d) => d.status === "decided" || d.status === "skipped")
  ) {
    return undefined;
  }
  return {
    status: "answered",
    answers: Object.fromEntries(
      decisions.map((d) => [d.question, d.status === "skipped" ? SKIPPED_ANSWER : answerText(d)]),
    ),
  };
}
