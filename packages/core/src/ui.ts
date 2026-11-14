/**
 * TUI / VS Code UI state as a pure reducer (ADR-0002). The render layer maps keys to actions,
 * shows the state, and runs the commands in `outbox` against the daemon.
 */
import type { AgentRun, Answer, Decision, DecisionStatus, Proposal } from "@dw/protocol";
import { DISCONNECT_REASON, isOpen, queueOrder } from "./decision";
import { isActionable } from "./graph";
import { overviewRows } from "./overview";

export type View = "current" | "queue" | "history" | "graph";

/** Requests for the daemon. Results come back as a new `sync`. */
export type Command =
  | { type: "answer"; id: string; expectedVersion: number; answer: Answer; rationale?: string }
  | { type: "transition"; id: string; expectedVersion: number; to: DecisionStatus; reason?: string }
  | { type: "hold"; id: string; expectedVersion: number; held: boolean }
  | { type: "fallback"; batchId: string }
  | { type: "explore"; id: string }
  | { type: "plan"; request: string }
  | { type: "review" }
  | { type: "resolveProposal"; id: string; accept: boolean }
  | { type: "cancelRun"; runId: string };

export type UiState = {
  view: View;
  help: boolean;
  decisions: Decision[];
  /** Decision shown in Current; falls back to the head of the queue. */
  focusId?: string;
  /** Option cursor and multi-select picks for the current decision. */
  cursor: number;
  picked: string[];
  /** Free-text editing: the answer itself, or the rationale ("why"). */
  editing?: "answer" | "why" | "plan";
  rationale?: string;
  /** Selection in Queue / History. */
  listIndex: number;
  notice?: string;
  /** Sent but not yet confirmed by a sync; hidden from Current meanwhile. */
  inFlight: { id: string; version: number }[];
  /** After a revisit, jump to that decision once it reopens. */
  revisitTarget?: string;
  outbox: Command[];
  /** Agent runs of the project (Deep Dive progress). */
  runs: AgentRun[];
  /** Open Reviewer proposals, shown at the top of History (T-310). */
  proposals: Proposal[];
};

export const initialUiState: UiState = {
  view: "current",
  help: false,
  decisions: [],
  cursor: 0,
  picked: [],
  listIndex: 0,
  inFlight: [],
  outbox: [],
  runs: [],
  proposals: [],
};

export type UiAction =
  | { type: "sync"; decisions: Decision[] }
  | { type: "runs"; runs: AgentRun[] }
  | { type: "proposals"; proposals: Proposal[] }
  | { type: "explore" }
  | { type: "review" }
  | { type: "resolve"; accept: boolean }
  | { type: "failed"; id?: string; message: string }
  | { type: "move"; delta: number }
  | { type: "number"; n: number }
  | { type: "toggle" }
  | { type: "confirm" }
  | { type: "edit"; mode: "answer" | "why" | "plan" | undefined }
  | { type: "submitText"; value: string }
  | { type: "skip" }
  | { type: "hold" }
  | { type: "fallback" }
  | { type: "revisit" }
  | { type: "view"; view?: View }
  | { type: "help" }
  | { type: "clearNotice" }
  | { type: "drained" };

const VIEWS: View[] = ["current", "queue", "history", "graph"];

// --- selectors ---------------------------------------------------------------------------------

export function openList(s: UiState): Decision[] {
  const busy = new Set(s.inFlight.map((f) => f.id));
  return queueOrder(s.decisions).filter((d) => !busy.has(d.id));
}

export function closedList(s: UiState): Decision[] {
  return s.decisions
    .filter((d) => !isOpen(d))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The Deep Dive running for a decision, if any. */
export function runningRun(s: UiState, decisionId: string): AgentRun | undefined {
  return s.runs.find((r) => r.target === decisionId && r.status === "running");
}

/** The decision to answer now. Never one still waiting on a prerequisite. */
export function currentDecision(s: UiState): Decision | undefined {
  const byId = new Map(s.decisions.map((d) => [d.id, d]));
  const open = openList(s).filter((d) => isActionable(d, byId));
  return open.find((d) => d.id === s.focusId) ?? open[0];
}

export type QueueRow = {
  decision: Decision;
  /** Nesting under its prerequisites within the queue (0 = top level). */
  depth: number;
  /** Prerequisites that are not decided yet. Empty = can be answered now. */
  waitingOn: string[];
  /** First row of a plan group: show the plan header above it. */
  planHeader?: string;
};

/**
 * Queue as a tree (T-305): grouped by plan, each decision under the prerequisite it was listed
 * after. Plain decisions (no plan) come first in queue order.
 */
export function queueRows(s: UiState): QueueRow[] {
  const open = openList(s);
  const openIds = new Set(open.map((d) => d.id));
  const byId = new Map(s.decisions.map((d) => [d.id, d]));
  const waitingOn = (d: Decision) =>
    d.dependsOn.filter((dep) => byId.get(dep.id)?.status !== "decided").map((dep) => dep.id);

  const groups = new Map<string, Decision[]>();
  for (const d of open) groups.set(d.planId ?? "", [...(groups.get(d.planId ?? "") ?? []), d]);
  const order = [...groups.keys()].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, undefined, { numeric: true }),
  );

  const rows: QueueRow[] = [];
  for (const plan of order) {
    const members = groups.get(plan) ?? [];
    const memberIds = new Set(members.map((d) => d.id));
    const children = new Map<string, Decision[]>();
    const roots: Decision[] = [];
    for (const d of members) {
      // Hang it under its first prerequisite that is also queued in this group.
      const parent = d.dependsOn.find((dep) => memberIds.has(dep.id) && openIds.has(dep.id));
      if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), d]);
      else roots.push(d);
    }
    const seen = new Set<string>();
    const walk = (d: Decision, depth: number) => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      rows.push({
        decision: d,
        depth,
        waitingOn: waitingOn(d),
        planHeader:
          rows.length === 0 || rows.at(-1)?.decision.planId !== d.planId
            ? plan || undefined
            : undefined,
      });
      for (const c of children.get(d.id) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
  }
  return rows;
}

/** History rows: open proposals first, then closed decisions (newest first). */
export type HistoryRow = { proposal: Proposal } | { decision: Decision };

export function historyRows(s: UiState): HistoryRow[] {
  return [
    ...s.proposals.map((proposal) => ({ proposal })),
    ...closedList(s).map((decision) => ({ decision })),
  ];
}

/** The proposal under the cursor in History, if a proposal row is selected. */
export function selectedProposal(s: UiState): Proposal | undefined {
  if (s.view !== "history") return undefined;
  return s.proposals[Math.min(s.listIndex, historyRows(s).length - 1)];
}

/** The reviewer run in progress, if any. */
export function runningReview(s: UiState): AgentRun | undefined {
  return s.runs.find((r) => r.kind === "reviewer" && r.status === "running");
}

/** The row under the cursor in Queue / History. */
export function selectedDecision(s: UiState): Decision | undefined {
  if (s.view === "history") {
    const row = historyRows(s)[Math.min(s.listIndex, historyRows(s).length - 1)];
    return row && "decision" in row ? row.decision : undefined;
  }
  const list =
    s.view === "graph"
      ? overviewRows(s.decisions).map((r) => r.decision)
      : queueRows(s).map((r) => r.decision);
  return list[Math.min(s.listIndex, list.length - 1)];
}

// --- reducer -----------------------------------------------------------------------------------

const resetQuestion = {
  cursor: 0,
  picked: [] as string[],
  editing: undefined,
  rationale: undefined,
};

function send(s: UiState, d: Decision, command: Command): UiState {
  return {
    ...s,
    ...resetQuestion,
    focusId: s.focusId === d.id ? undefined : s.focusId,
    inFlight: [...s.inFlight, { id: d.id, version: d.version }],
    outbox: [...s.outbox, command],
  };
}

function answerWith(s: UiState, d: Decision, answer: Answer): UiState {
  return send(s, d, {
    type: "answer",
    id: d.id,
    expectedVersion: d.version,
    answer,
    rationale: s.rationale,
  });
}

export function uiReducer(s: UiState, a: UiAction): UiState {
  const current = currentDecision(s);
  const optionCount = current?.options.length ?? 0;

  switch (a.type) {
    case "sync": {
      const before = new Map(s.decisions.map((d) => [d.id, d]));
      const fresh = a.decisions.filter((d) => !before.has(d.id) && isOpen(d));
      // A request is settled once its decision moved on to a new version.
      const inFlight = s.inFlight.filter(
        (f) => a.decisions.find((d) => d.id === f.id)?.version === f.version,
      );
      let next: UiState = { ...s, decisions: a.decisions, inFlight };
      if (fresh.length > 0)
        next.notice = `${fresh.length} new question${fresh.length === 1 ? "" : "s"}`;

      // The decision on screen was closed by someone else: tell the user why it disappeared.
      const shown = current && a.decisions.find((d) => d.id === current.id);
      if (current && shown && !isOpen(shown) && !s.inFlight.some((f) => f.id === current.id)) {
        next = { ...next, ...resetQuestion, focusId: undefined };
        if (shown.closedReason === DISCONNECT_REASON) {
          next.notice = "Claude Code withdrew the question you were answering"; // Esc / timeout (ADR-0004)
        } else if (shown.status === "decided") {
          next.notice = `${shown.id} was answered elsewhere`;
        }
      }
      if (s.revisitTarget) {
        const target = a.decisions.find((d) => d.id === s.revisitTarget);
        if (target && isOpen(target)) {
          next = {
            ...next,
            ...resetQuestion,
            focusId: target.id,
            view: "current",
            revisitTarget: undefined,
          };
        }
      }
      return next;
    }
    case "runs": {
      // Announce Deep Dives that just finished.
      const before = new Map(s.runs.map((r) => [r.id, r]));
      const finished = a.runs.filter(
        (r) => before.get(r.id)?.status === "running" && r.status !== "running",
      );
      const last = finished.at(-1);
      const what =
        last?.kind === "planner" ? "Planning" : last?.kind === "reviewer" ? "Review" : "Deep Dive";
      const subject =
        last?.kind === "reviewer" && last.target === "project" ? "" : ` of ${last?.target}`;
      const notice = !last
        ? s.notice
        : last.status === "succeeded"
          ? last.kind === "planner"
            ? `Planning ${last.target} finished (see Queue / Graph)`
            : last.kind === "reviewer"
              ? `Review${subject} finished (proposals are in History)`
              : `${what} of ${last.target} finished`
          : last.status === "cancelled"
            ? `${what}${subject} cancelled`
            : `${what}${subject} failed: ${last.error ?? ""}`;
      return { ...s, runs: a.runs, notice };
    }
    case "proposals": {
      const length = a.proposals.length + closedList(s).length;
      return {
        ...s,
        proposals: a.proposals,
        listIndex: Math.min(s.listIndex, Math.max(0, length - 1)),
      };
    }
    case "review": {
      const run = runningReview(s);
      if (run) return { ...s, outbox: [...s.outbox, { type: "cancelRun", runId: run.id }] };
      return {
        ...s,
        notice: "Reviewer is checking the decided answers (calls the model)",
        outbox: [...s.outbox, { type: "review" }],
      };
    }
    case "resolve": {
      const p = selectedProposal(s);
      if (!p) return s;
      // A reopened decision opens in Current once the daemon confirms it (like revisit).
      const reopen =
        a.accept && p.kind !== "add"
          ? p.decisionIds.find((id) => s.decisions.find((d) => d.id === id)?.status === "decided")
          : undefined;
      return {
        ...s,
        proposals: s.proposals.filter((x) => x.id !== p.id),
        revisitTarget: reopen ?? s.revisitTarget,
        notice: a.accept
          ? p.kind === "add"
            ? `Accepted ${p.id}: adding the new decision to the Queue`
            : `Accepted ${p.id}: reopening ${p.decisionIds.join(", ")}`
          : `Dismissed ${p.id}`,
        outbox: [...s.outbox, { type: "resolveProposal", id: p.id, accept: a.accept }],
      };
    }
    case "explore": {
      const d = s.view === "current" ? currentDecision(s) : selectedDecision(s);
      if (!d || !isOpen(d)) return s;
      const run = runningRun(s, d.id);
      if (run) return { ...s, outbox: [...s.outbox, { type: "cancelRun", runId: run.id }] };
      return {
        ...s,
        notice: `Deep Dive of ${d.id} started (calls the model)`,
        outbox: [...s.outbox, { type: "explore", id: d.id }],
      };
    }
    case "failed":
      return {
        ...s,
        inFlight: a.id ? s.inFlight.filter((f) => f.id !== a.id) : s.inFlight,
        notice: a.message,
      };
    case "move": {
      if (s.view === "current") {
        if (optionCount === 0) return s;
        return { ...s, cursor: (s.cursor + a.delta + optionCount) % optionCount };
      }
      const length =
        s.view === "history"
          ? historyRows(s).length
          : s.view === "graph"
            ? overviewRows(s.decisions).length
            : queueRows(s).length;
      if (length === 0) return s;
      return { ...s, listIndex: Math.max(0, Math.min(length - 1, s.listIndex + a.delta)) };
    }
    case "number": {
      if (s.view !== "current" || !current) return s;
      const i = a.n - 1;
      if (i < 0 || i >= optionCount) return s;
      const moved = { ...s, cursor: i };
      return current.kind === "multi" ? uiReducer(moved, { type: "toggle" }) : moved;
    }
    case "toggle": {
      if (current?.kind !== "multi") return s;
      const id = current.options[s.cursor]?.id;
      if (!id) return s;
      const picked = s.picked.includes(id) ? s.picked.filter((p) => p !== id) : [...s.picked, id];
      const order = current.options.map((o) => o.id);
      return { ...s, picked: picked.sort((x, y) => order.indexOf(x) - order.indexOf(y)) };
    }
    case "confirm": {
      if (s.view === "queue" || s.view === "graph") {
        const d = selectedDecision(s);
        if (!d) return s;
        const byId = new Map(s.decisions.map((x) => [x.id, x]));
        if (s.view === "graph" && !isActionable(d, byId)) {
          return { ...s, notice: `${d.id} cannot be answered now (${d.status})` };
        }
        return { ...s, ...resetQuestion, focusId: d.id, view: "current" };
      }
      if (s.view !== "current" || !current) return s;
      if (current.kind === "text") return { ...s, editing: "answer" };
      const id = current.options[s.cursor]?.id;
      const selection = current.kind === "multi" && s.picked.length > 0 ? s.picked : id ? [id] : [];
      return selection.length > 0 ? answerWith(s, current, { selected: selection }) : s;
    }
    case "edit":
      if (a.mode === "answer" && current && !current.allowOther) {
        return { ...s, notice: "This question does not take free text" };
      }
      if (a.mode === "plan") return { ...s, editing: "plan" };
      return current || !a.mode ? { ...s, editing: a.mode } : s;
    case "submitText": {
      const value = a.value.trim();
      if (s.editing === "plan") {
        if (!value) return { ...s, editing: undefined };
        return {
          ...s,
          editing: undefined,
          notice: "Planner is listing the decisions (calls the model)",
          outbox: [...s.outbox, { type: "plan", request: value }],
        };
      }
      if (s.editing === "why") return { ...s, editing: undefined, rationale: value || undefined };
      if (!current || !value) return { ...s, editing: undefined };
      return answerWith(s, current, { selected: [], text: value });
    }
    case "skip": {
      const d = s.view === "current" ? current : selectedDecision(s);
      if (!d || !isOpen(d)) return s;
      return send(s, d, {
        type: "transition",
        id: d.id,
        expectedVersion: d.version,
        to: "skipped",
        reason: "user",
      });
    }
    case "hold": {
      const d = s.view === "current" ? current : selectedDecision(s);
      if (!d || !isOpen(d)) return s;
      return send(s, d, { type: "hold", id: d.id, expectedVersion: d.version, held: !d.held });
    }
    case "fallback": {
      if (!current?.batchId)
        return { ...s, notice: "Not a Claude Code question: nothing to hand back" };
      const batch = current.batchId;
      const members = s.decisions.filter((d) => d.batchId === batch && isOpen(d));
      return {
        ...s,
        ...resetQuestion,
        focusId: undefined,
        inFlight: [...s.inFlight, ...members.map((d) => ({ id: d.id, version: d.version }))],
        outbox: [...s.outbox, { type: "fallback", batchId: batch }],
      };
    }
    case "revisit": {
      const d = s.view === "history" || s.view === "graph" ? selectedDecision(s) : undefined;
      if (d?.status !== "decided") return s;
      return {
        ...s,
        revisitTarget: d.id,
        outbox: [
          ...s.outbox,
          { type: "transition", id: d.id, expectedVersion: d.version, to: "revisit" },
        ],
      };
    }
    case "view": {
      const view = a.view ?? VIEWS[(VIEWS.indexOf(s.view) + 1) % VIEWS.length] ?? "current";
      return { ...s, view, listIndex: 0, help: false, editing: undefined };
    }
    case "help":
      return { ...s, help: !s.help };
    case "clearNotice":
      return { ...s, notice: undefined };
    case "drained":
      return { ...s, outbox: [] };
  }
}
