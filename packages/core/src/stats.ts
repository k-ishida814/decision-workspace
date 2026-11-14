/** `dw stats` (T-313, NFR-10): totals from agent runs, context deliveries and decisions. Pure. */
import type { AgentKind, AgentRun, Decision, DeliveryLogEntry, Stats } from "@dw/protocol";

type AgentTotals = Stats["agents"]["total"];

const KINDS: readonly AgentKind[] = ["planner", "explorer", "reviewer"];

function totals(runs: readonly AgentRun[]): AgentTotals {
  const t: AgentTotals = {
    runs: runs.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  };
  for (const r of runs) {
    t[r.status]++;
    t.costUsd += r.costUsd ?? 0;
    t.inputTokens += r.inputTokens ?? 0;
    t.outputTokens += r.outputTokens ?? 0;
    t.durationMs += r.durationMs ?? 0;
  }
  return t;
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export function computeStats(input: {
  runs: readonly AgentRun[];
  deliveries: readonly DeliveryLogEntry[];
  sessions: number;
  decisions: readonly Decision[];
}): Stats {
  const byKind = Object.fromEntries(
    KINDS.map((k) => [k, totals(input.runs.filter((r) => r.kind === k))]),
  ) as Record<AgentKind, AgentTotals>;
  return {
    agents: { total: totals(input.runs), byKind },
    context: {
      sessions: input.sessions,
      blocks: input.deliveries.length,
      decisions: input.deliveries.reduce((n, d) => n + d.items, 0),
      chars: input.deliveries.reduce((n, d) => n + d.chars, 0),
      maxChars: input.deliveries.reduce((n, d) => Math.max(n, d.chars), 0),
    },
    decisions: {
      total: input.decisions.length,
      byStatus: countBy(input.decisions, (d) => d.status),
      byOrigin: countBy(input.decisions, (d) => d.origin),
      answers: input.decisions.reduce((n, d) => n + d.revision, 0),
      changed: input.decisions.filter((d) => d.revision > 1).length,
    },
  };
}

/** Human-readable report for `dw stats`. */
export function statsText(s: Stats): string {
  const usd = (n: number) => `$${n.toFixed(3)}`;
  const tokens = (t: AgentTotals) =>
    `${t.inputTokens.toLocaleString("en")} in / ${t.outputTokens.toLocaleString("en")} out`;
  const row = (name: string, t: AgentTotals) =>
    `  ${name.padEnd(9)} ${String(t.runs).padStart(3)} runs  ${t.succeeded} ok / ${t.failed} failed / ${t.cancelled} cancelled${t.running ? ` / ${t.running} running` : ""}  ${usd(t.costUsd)}  ${tokens(t)}  ${(t.durationMs / 1000).toFixed(1)}s`;
  const lines = ["Agents"];
  for (const k of KINDS) lines.push(row(k, s.agents.byKind[k]));
  lines.push(row("total", s.agents.total));
  const c = s.context;
  lines.push(
    "Context handed to Claude (next prompt)",
    `  ${c.sessions} sessions, ${c.blocks} blocks, ${c.decisions} decisions, ${c.chars.toLocaleString("en")} chars (largest ${c.maxChars.toLocaleString("en")}, avg ${c.blocks ? Math.round(c.chars / c.blocks) : 0})`,
  );
  const d = s.decisions;
  const list = (r: Record<string, number>) =>
    Object.entries(r)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "-";
  lines.push(
    "Decisions",
    `  ${d.total} total: ${list(d.byStatus)}`,
    `  by origin: ${list(d.byOrigin)}`,
    `  ${d.answers} answers, ${d.changed} decisions answered more than once`,
  );
  return lines.join("\n");
}
