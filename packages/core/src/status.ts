import type { DecisionStatus } from "@dw/protocol";

/** Allowed state transitions (requirements DQ-03). Anything not listed is rejected. */
const TRANSITIONS: Readonly<Record<DecisionStatus, readonly DecisionStatus[]>> = {
  pending: ["exploring", "ready", "skipped", "cancelled"],
  exploring: ["pending", "ready", "skipped", "cancelled"],
  ready: ["exploring", "decided", "skipped", "cancelled"],
  decided: ["revisit", "cancelled"],
  revisit: ["exploring", "ready", "decided", "skipped", "cancelled"],
  skipped: ["pending"],
  cancelled: [],
};

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
