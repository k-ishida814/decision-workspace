/** Explorer agent (AG-02, T-308): researches one decision for a Deep Dive. */
import type { Decision } from "@dw/protocol";
import { z } from "zod";
import systemPrompt from "../agents/explorer.md" with { type: "text" };
import type { AgentSpec } from "./runner";

export const ExplorerOutput = z.object({
  summary: z.string().min(1),
  tradeoffs: z.array(
    z.object({ optionId: z.string(), pros: z.array(z.string()), cons: z.array(z.string()) }),
  ),
  recommended: z.object({ optionId: z.string(), reason: z.string() }),
  newOptions: z.array(z.object({ label: z.string().min(1), description: z.string() })).max(3),
});
export type ExplorerOutput = z.infer<typeof ExplorerOutput>;

/** Keep untrusted text from closing our <data> block (NFR-09). */
function data(text: string): string {
  return text.replaceAll("</data>", "<\\/data>");
}

/**
 * The task for one decision. Prerequisites are given as context because they constrain the
 * answer ("storage = cloud" changes which sync options make sense).
 */
export function explorerSpec(
  decision: Decision,
  all: readonly Decision[],
  cwd: string,
): AgentSpec<ExplorerOutput> {
  const lines = [
    `Decision ${decision.id}${decision.title ? ` (${decision.title})` : ""}: ${decision.question}`,
    `Answer type: ${decision.kind}${decision.allowOther ? " (free text allowed)" : ""}`,
    "Options:",
    ...(decision.options.length > 0
      ? decision.options.map(
          (o) => `- ${o.id}: ${o.label}${o.description ? ` — ${o.description}` : ""}`,
        )
      : ["(none yet: propose some as newOptions)"]),
  ];
  const prerequisites = decision.dependsOn
    .map((dep) => all.find((d) => d.id === dep.id))
    .filter((d): d is Decision => d?.status === "decided");
  if (prerequisites.length > 0) {
    lines.push("Already decided (constraints):");
    for (const p of prerequisites) {
      const labels =
        p.answer?.selected.map((id) => p.options.find((o) => o.id === id)?.label ?? id) ?? [];
      const value = [labels.join(", "), p.answer?.text].filter(Boolean).join(" / ");
      lines.push(`- ${p.question} → ${value}${p.rationale ? ` (reason: ${p.rationale})` : ""}`);
    }
  }
  return {
    kind: "explorer",
    schema: ExplorerOutput,
    systemPrompt,
    prompt: `<data>\n${data(lines.join("\n"))}\n</data>\nExplore this decision.`,
    cwd,
  };
}
