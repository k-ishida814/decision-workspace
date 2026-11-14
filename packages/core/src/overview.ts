/**
 * Whole-graph overview (T-314, T-315, DG-07): every decision of a plan, decided or not, as a
 * tree for reading and as Mermaid for drawing. Pure.
 */
import type { Decision, Dependency } from "@dw/protocol";
import { answerText } from "./decision";

export type OverviewRow = {
  decision: Decision;
  depth: number;
  /** The prerequisite this row is drawn under (its tree parent), if any. */
  via?: Dependency;
  /** Other prerequisites, not shown by the tree shape. */
  alsoAfter: string[];
  /** Plan id for the first row of each plan group ("" = decisions without a plan). */
  planHeader?: string;
};

const num = (id: string) => Number(id.slice(2));

/** Plans first in id order, then decisions without a plan. Optionally only one plan. */
export function overviewRows(decisions: readonly Decision[], planId?: string): OverviewRow[] {
  const groups = new Map<string, Decision[]>();
  for (const d of [...decisions].sort((a, b) => num(a.id) - num(b.id))) {
    const key = d.planId ?? "";
    if (planId !== undefined && key !== planId) continue;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : num(a) - num(b)));

  const rows: OverviewRow[] = [];
  for (const key of order) {
    const members = groups.get(key) ?? [];
    const ids = new Set(members.map((d) => d.id));
    const children = new Map<string, Decision[]>();
    const roots: Decision[] = [];
    for (const d of members) {
      const parent = d.dependsOn.find((dep) => ids.has(dep.id));
      if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), d]);
      else roots.push(d);
    }
    let first = true;
    const seen = new Set<string>();
    const walk = (d: Decision, depth: number, via?: Dependency) => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      rows.push({
        decision: d,
        depth,
        via,
        alsoAfter: d.dependsOn.filter((dep) => dep.id !== via?.id).map((dep) => dep.id),
        planHeader: first ? key : undefined,
      });
      first = false;
      for (const c of children.get(d.id) ?? []) {
        walk(
          c,
          depth + 1,
          c.dependsOn.find((dep) => dep.id === d.id),
        );
      }
    };
    for (const r of roots) walk(r, 0);
  }
  return rows;
}

/** Tree guides ("│  ├─", "   └─", …) for each row, shared by `dw graph` and the TUI. */
export function treePrefixes(rows: readonly OverviewRow[]): string[] {
  // A row is the last of its siblings when no later row at the same depth comes before the
  // tree climbs back above it (or a new plan starts).
  const isLast = rows.map((row, i) => {
    for (const r of rows.slice(i + 1)) {
      if (r.planHeader !== undefined || r.depth < row.depth) return true;
      if (r.depth === row.depth) return false;
    }
    return true;
  });
  const ancestorIsLast: boolean[] = [];
  return rows.map((row, i) => {
    const guides = ancestorIsLast.slice(0, row.depth).map((last) => (last ? "   " : "│  "));
    ancestorIsLast[row.depth] = isLast[i] ?? true;
    return `${guides.join("")}${isLast[i] ? "└─" : "├─"}`;
  });
}

/** "cloud / on-prem" for a condition, using the prerequisite's labels. */
export function conditionText(dep: Dependency, all: readonly Decision[]): string | undefined {
  if (!dep.whenOptions) return undefined;
  const parent = all.find((d) => d.id === dep.id);
  return dep.whenOptions
    .map((o) => parent?.options.find((x) => x.id === o)?.label ?? o)
    .join(" / ");
}

function statusText(d: Decision): string {
  if (d.status === "skipped" || d.status === "cancelled") {
    return d.closedReason ? `${d.status}: ${d.closedReason}` : d.status;
  }
  return d.status;
}

/** `dw graph` text: one tree per plan, with answers and conditions. */
export function overviewText(
  decisions: readonly Decision[],
  plans: readonly { id: string; request: string }[],
  planId?: string,
): string {
  const rows = overviewRows(decisions, planId);
  if (rows.length === 0) return planId ? `no decisions in ${planId}` : "no decisions";
  const prefixes = treePrefixes(rows);
  const out: string[] = [];
  rows.forEach((row, i) => {
    if (row.planHeader !== undefined) {
      if (out.length > 0) out.push("");
      const plan = plans.find((p) => p.id === row.planHeader);
      out.push(row.planHeader ? `${row.planHeader} ${plan?.request ?? ""}`.trim() : "(no plan)");
    }
    const d = row.decision;
    const label = d.title || d.question;
    const answer = d.status === "decided" || d.status === "revisit" ? ` → ${answerText(d)}` : "";
    const condition = row.via ? conditionText(row.via, decisions) : undefined;
    const notes = [
      condition ? `when ${row.via?.id} = ${condition}` : "",
      row.alsoAfter.length > 0 ? `also after ${row.alsoAfter.join(", ")}` : "",
    ].filter(Boolean);
    const note = notes.length > 0 ? `  (${notes.join("; ")})` : "";
    out.push(`${prefixes[i]} ${d.id} [${statusText(d)}] ${label}${answer}${note}`);
  });
  return out.join("\n");
}

const MERMAID_CLASSES: Record<string, string> = {
  decided: "fill:#d1fae5,stroke:#059669,color:#064e3b",
  ready: "fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
  revisit: "fill:#fef3c7,stroke:#d97706,color:#78350f",
  pending: "fill:#f3f4f6,stroke:#9ca3af,color:#374151",
  exploring: "fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
  skipped: "fill:#f9fafb,stroke:#d1d5db,color:#9ca3af,stroke-dasharray:4 3",
  cancelled: "fill:#f9fafb,stroke:#d1d5db,color:#9ca3af,stroke-dasharray:4 3",
};

/** Text inside a Mermaid quoted label: quotes and angle brackets as entities. */
function mermaidText(s: string): string {
  return s
    .replaceAll("&", "#amp;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;");
}

/**
 * `dw graph --format mermaid`: every dependency is an edge from prerequisite to dependent,
 * labelled with its condition; nodes are coloured by status. Plans become subgraphs.
 */
export function overviewMermaid(
  decisions: readonly Decision[],
  plans: readonly { id: string; request: string }[],
  planId?: string,
): string {
  const rows = overviewRows(decisions, planId);
  const node = (id: string) => id.replace("-", "");
  const shown = new Set(rows.map((r) => r.decision.id));
  const lines = ["flowchart TD"];
  let open = false;
  for (const row of rows) {
    if (row.planHeader !== undefined) {
      if (open) lines.push("  end");
      open = row.planHeader !== "";
      if (open) {
        const plan = plans.find((p) => p.id === row.planHeader);
        lines.push(
          `  subgraph ${node(row.planHeader)}["${mermaidText(`${row.planHeader} ${plan?.request ?? ""}`.trim())}"]`,
        );
      }
    }
    const d = row.decision;
    const answer =
      d.status === "decided" || d.status === "revisit"
        ? `<br/>→ ${mermaidText(answerText(d))}`
        : "";
    const indent = open ? "    " : "  ";
    lines.push(
      `${indent}${node(d.id)}["${d.id} ${mermaidText(d.title || d.question)}${answer}"]:::${d.status}`,
    );
  }
  if (open) lines.push("  end");
  for (const row of rows) {
    for (const dep of row.decision.dependsOn) {
      if (!shown.has(dep.id)) continue;
      const condition = conditionText(dep, decisions);
      lines.push(
        condition
          ? `  ${node(dep.id)} -- "${mermaidText(condition)}" --> ${node(row.decision.id)}`
          : `  ${node(dep.id)} --> ${node(row.decision.id)}`,
      );
    }
  }
  const used = new Set(rows.map((r) => r.decision.status));
  for (const [status, style] of Object.entries(MERMAID_CLASSES)) {
    if (used.has(status as Decision["status"])) lines.push(`  classDef ${status} ${style}`);
  }
  return lines.join("\n");
}
