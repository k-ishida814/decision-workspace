/**
 * Decision Graph (T-302, design/phase3.md §4). Pure functions over the full list of a project's
 * decisions; the store applies the returned changes in one transaction.
 */
import type { Decision, DecisionStatus } from "@dw/protocol";

/** Closed reasons the graph sets itself. Only these are reopened automatically. */
export const CONDITION_UNMET = "condition-unmet";
export const PREREQUISITE_CLOSED = "prerequisite-closed";
const AUTO_SKIP = new Set([CONDITION_UNMET, PREREQUISITE_CLOSED]);

export function isAutoSkipped(d: Decision): boolean {
  return d.status === "skipped" && AUTO_SKIP.has(d.closedReason ?? "");
}

type Node = Pick<Decision, "id" | "dependsOn">;

/** A dependency cycle as a path that starts and ends at the same id, or undefined (DG-02). */
export function findCycle(nodes: readonly Node[]): string[] | undefined {
  const edges = new Map(nodes.map((n) => [n.id, n.dependsOn.map((d) => d.id)]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of edges.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Whether a decision's prerequisites allow it (D3, D4):
 * - "open":    every prerequisite is decided and every condition holds
 * - "blocked": some prerequisite is not decided yet
 * - "unmet":   a condition does not hold, or a prerequisite was skipped / cancelled
 */
export type Gate =
  | "open"
  | "blocked"
  | { unmet: typeof CONDITION_UNMET | typeof PREREQUISITE_CLOSED };

export function gate(d: Decision, byId: ReadonlyMap<string, Decision>): Gate {
  let blocked = false;
  for (const dep of d.dependsOn) {
    const parent = byId.get(dep.id);
    if (!parent) continue; // dangling ids cannot be created; ignore defensively
    if (parent.status === "skipped" || parent.status === "cancelled") {
      return { unmet: PREREQUISITE_CLOSED };
    }
    if (parent.status !== "decided") {
      blocked = true;
      continue;
    }
    if (dep.whenOptions && !dep.whenOptions.some((o) => parent.answer?.selected.includes(o))) {
      return { unmet: CONDITION_UNMET };
    }
  }
  return blocked ? "blocked" : "open";
}

/** Can the user act on it now? (shown in Current) */
export function isActionable(d: Decision, byId: ReadonlyMap<string, Decision>): boolean {
  return (d.status === "ready" || d.status === "revisit") && gate(d, byId) === "open";
}

/** Status a new decision starts in, given its prerequisites. */
export function initialStatus(
  d: Decision,
  byId: ReadonlyMap<string, Decision>,
): Pick<Decision, "status" | "closedReason"> {
  const g = gate(d, byId);
  if (g === "open") return { status: "ready", closedReason: undefined };
  if (g === "blocked") return { status: "pending", closedReason: undefined };
  return { status: "skipped", closedReason: g.unmet };
}

/** Every decision that depends on `id`, directly or not, nearest first. */
export function dependentsOf(id: string, decisions: readonly Decision[]): Decision[] {
  const children = new Map<string, Decision[]>();
  for (const d of decisions) {
    for (const dep of d.dependsOn) children.set(dep.id, [...(children.get(dep.id) ?? []), d]);
  }
  const seen = new Set<string>();
  const out: Decision[] = [];
  const queue = [...(children.get(id) ?? [])];
  while (queue.length > 0) {
    const d = queue.shift() as Decision;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
    queue.push(...(children.get(d.id) ?? []));
  }
  return out;
}

/**
 * After `changed` was updated (answered, reopened, skipped, cancelled…), work out what happens to
 * everything downstream (D2, DG-03, DG-04). Returns only the decisions whose status changed, with
 * version and updatedAt bumped. `changed` must already be in `decisions` in its new state.
 */
export function propagate(
  changed: Decision,
  decisions: readonly Decision[],
  now: string,
): Decision[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const updates: Decision[] = [];

  // Process in dependency order so each decision sees its prerequisites' new state.
  for (const original of topologicalOrder(dependentsOf(changed.id, decisions))) {
    const d = byId.get(original.id) as Decision;
    const g = gate(d, byId);
    const next = nextState(d, g);
    if (!next) continue;
    const updated: Decision = {
      ...d,
      status: next.status,
      closedReason: next.closedReason,
      held: next.status === "skipped" ? false : d.held,
      version: d.version + 1,
      updatedAt: now,
    };
    byId.set(d.id, updated);
    updates.push(updated);
  }
  return updates;
}

function nextState(
  d: Decision,
  g: Gate,
): { status: DecisionStatus; closedReason?: string } | undefined {
  const unmet = typeof g === "object" ? g.unmet : undefined;
  switch (d.status) {
    case "decided":
      if (unmet) return { status: "skipped", closedReason: unmet };
      // An answer resting on a prerequisite that is being reconsidered must be re-checked.
      return g === "blocked" ? { status: "revisit" } : undefined;
    case "revisit":
      return unmet ? { status: "skipped", closedReason: unmet } : undefined; // stays until re-answered
    case "ready":
      if (unmet) return { status: "skipped", closedReason: unmet };
      return g === "blocked" ? { status: "pending" } : undefined;
    case "pending":
      if (unmet) return { status: "skipped", closedReason: unmet };
      return g === "open" ? { status: "ready" } : undefined;
    case "exploring":
      return unmet ? { status: "skipped", closedReason: unmet } : undefined;
    case "skipped":
      if (!isAutoSkipped(d)) return undefined; // the user skipped it: leave it alone
      if (unmet)
        return unmet === d.closedReason ? undefined : { status: "skipped", closedReason: unmet };
      // Prerequisites allow it again; it was never answered (or its answer is stale).
      if (d.revision > 0) return { status: "revisit" };
      return { status: g === "open" ? "ready" : "pending" };
    case "cancelled":
      return undefined;
  }
}

function topologicalOrder(subset: readonly Decision[]): Decision[] {
  const ids = new Set(subset.map((d) => d.id));
  const done = new Set<string>();
  const out: Decision[] = [];
  const byId = new Map(subset.map((d) => [d.id, d]));
  const visit = (d: Decision) => {
    if (done.has(d.id)) return;
    done.add(d.id);
    for (const dep of d.dependsOn) {
      const parent = byId.get(dep.id);
      if (parent && ids.has(parent.id)) visit(parent);
    }
    out.push(d);
  };
  for (const d of subset) visit(d);
  return out;
}
