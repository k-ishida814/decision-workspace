/** Planner agent (AG-01, T-309): turns a request into a plan of decisions with dependencies. */
import type { Decision } from "@dw/protocol";
import { z } from "zod";
import systemPrompt from "../agents/planner.md" with { type: "text" };
import type { AgentSpec } from "./runner";

export const PlannerOutput = z.object({
  decisions: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
        title: z.string(),
        question: z.string().min(1),
        multiSelect: z.boolean(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string() })).max(6),
        dependsOn: z.array(z.object({ ref: z.string(), whenOptions: z.array(z.string()) })),
      }),
    )
    .min(1)
    .max(12),
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

/** How many existing decisions to show the Planner, so it does not ask them again. */
const CONTEXT_LIMIT = 30;

function data(text: string): string {
  return text.replaceAll("</data>", "<\\/data>");
}

export function plannerSpec(
  request: string,
  existing: readonly Decision[],
  cwd: string,
): AgentSpec<PlannerOutput> {
  const lines = [`Request: ${request}`];
  const decided = existing.filter((d) => d.status === "decided").slice(-CONTEXT_LIMIT);
  if (decided.length > 0) {
    lines.push("Already decided:");
    for (const d of decided) {
      const labels =
        d.answer?.selected.map((id) => d.options.find((o) => o.id === id)?.label ?? id) ?? [];
      lines.push(
        `- ${d.question} → ${[labels.join(", "), d.answer?.text].filter(Boolean).join(" / ")}`,
      );
    }
  }
  const open = existing
    .filter((d) => d.status === "ready" || d.status === "pending" || d.status === "revisit")
    .slice(-CONTEXT_LIMIT);
  if (open.length > 0) {
    lines.push("Already open (do not repeat):");
    for (const d of open) lines.push(`- ${d.question}`);
  }
  return {
    kind: "planner",
    schema: PlannerOutput,
    systemPrompt,
    prompt: `<data>\n${data(lines.join("\n"))}\n</data>\nList the decisions for this request.`,
    cwd,
  };
}
