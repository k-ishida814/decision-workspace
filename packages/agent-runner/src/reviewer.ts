/** Reviewer agent (AG-03, T-310): finds conflicts between answers and decisions worth revisiting. */
import type { Decision } from "@dw/protocol";
import { z } from "zod";
import systemPrompt from "../agents/reviewer.md" with { type: "text" };
import type { AgentSpec } from "./runner";

export const ReviewerOutput = z.object({
  proposals: z
    .array(
      z.object({
        kind: z.enum(["conflict", "revisit", "add"]),
        title: z.string().min(1),
        reason: z.string().min(1),
        /** conflict / revisit: decided decisions to reopen. add: prerequisites of the new one. */
        decisionIds: z.array(z.string()),
        /** add only ("" otherwise). */
        question: z.string(),
        multiSelect: z.boolean(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string() })).max(6),
      }),
    )
    .max(10),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

/** How many decided decisions to review at most (newest first are kept). */
const DECIDED_LIMIT = 60;
const OPEN_LIMIT = 30;

function data(text: string): string {
  return text.replaceAll("</data>", "<\\/data>");
}

function answerOf(d: Decision): string {
  const labels = d.answer?.selected.map((id) => d.options.find((o) => o.id === id)?.label ?? id);
  return [labels?.join(", "), d.answer?.text].filter(Boolean).join(" / ");
}

/** @param scope decisions of the reviewed plan (or the whole project) */
export function reviewerSpec(scope: readonly Decision[], cwd: string): AgentSpec<ReviewerOutput> {
  const decided = scope.filter((d) => d.status === "decided").slice(-DECIDED_LIMIT);
  const lines = ["Decided:"];
  for (const d of decided) {
    const after =
      d.dependsOn.length > 0 ? ` [after ${d.dependsOn.map((x) => x.id).join(", ")}]` : "";
    lines.push(
      `- ${d.id}${d.title ? ` (${d.title})` : ""}: ${d.question} → ${answerOf(d)}${d.rationale ? ` (reason: ${d.rationale})` : ""}${after}`,
    );
  }
  const open = scope
    .filter((d) => d.status === "ready" || d.status === "pending" || d.status === "revisit")
    .slice(-OPEN_LIMIT);
  if (open.length > 0) {
    lines.push("Still open (do not propose these again):");
    for (const d of open) lines.push(`- ${d.id}: ${d.question}`);
  }
  return {
    kind: "reviewer",
    schema: ReviewerOutput,
    systemPrompt,
    prompt: `<data>\n${data(lines.join("\n"))}\n</data>\nReview these decisions.`,
    cwd,
  };
}
