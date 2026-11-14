/**
 * MCP server for Claude Code (T-311, CC-04, CC-10). Lets Claude queue many decisions without
 * waiting, and read decided ones later. Talks to the daemon; holds no state.
 */
import { answerText, fromDrafts, isOpen, queueOrder, referencedIds } from "@dw/core";
import type { DwClient } from "@dw/ipc-client";
import { type Decision, VERSION } from "@dw/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Keep what we hand back to Claude small (NFR-06). */
export const LIST_LIMIT = 30;

const AskInput = {
  title: z
    .string()
    .min(1)
    .describe(
      "What these decisions are about, e.g. 'Sync feature design'. Shown as the plan name.",
    ),
  decisions: z
    .array(
      z.object({
        key: z.string().min(1).describe("Short unique name in this call, used by dependsOn."),
        title: z.string().describe("2-6 word label.").optional(),
        question: z.string().min(1),
        multiSelect: z.boolean().optional(),
        options: z
          .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
          .describe("Leave empty for a free-text question or when the user should Deep Dive first.")
          .optional(),
        recommended: z.string().describe("Label of the option you recommend, if any.").optional(),
        dependsOn: z
          .array(
            z.object({
              ref: z
                .string()
                .describe("key of another decision in this call, or an existing id like D-3"),
              whenOptions: z
                .array(z.string())
                .describe(
                  "Only ask this if the prerequisite was answered with one of these labels.",
                )
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(50),
};

const ASK_DESCRIPTION = `Queue decisions for the user in Decision Workspace and return immediately (no waiting).
Use this instead of AskUserQuestion when there are many decisions, when they depend on each other, or when the user should be able to research (Deep Dive) and answer later. Use AskUserQuestion only for 1-4 questions you need answered right now.
After queueing, tell the user they can answer in \`dw tui\`, and stop or continue with work that does not depend on the answers. Decisions the user makes are added to your context automatically with their next message; you can also read them with decision_list / decision_get.
Decision ids (D-n) stay stable; refer to them later.`;

function line(d: Decision): string {
  const title = d.title ? `${d.title}: ` : "";
  if (d.status === "decided") {
    return `${d.id} ${title}${d.question} → ${answerText(d)}${d.rationale ? ` (reason: ${d.rationale})` : ""}`;
  }
  const waiting =
    d.status === "pending" ? ` [waiting on ${d.dependsOn.map((x) => x.id).join(", ")}]` : "";
  const why = d.closedReason ? ` (${d.closedReason})` : "";
  return `${d.id} [${d.status}]${waiting} ${title}${d.question}${why}`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export function createMcpServer(client: DwClient, project: string): McpServer {
  const server = new McpServer({ name: "decision-workspace", version: VERSION });

  server.registerTool(
    "decision_ask",
    { title: "Queue decisions", description: ASK_DESCRIPTION, inputSchema: AskInput },
    async ({ title, decisions }) => {
      try {
        const existing = new Map<string, Decision>();
        for (const id of referencedIds(decisions)) {
          existing.set(id, (await client.call("decision.get", { project, id })).decision);
        }
        const input = fromDrafts(decisions, existing, "claude");
        const { plan, decisions: created } = await client.call("plan.create", {
          project,
          request: title,
          source: "claude",
          decisions: input,
        });
        const keys = decisions.map(
          (d, i) => `${d.key} = ${created[i]?.id} [${created[i]?.status}]`,
        );
        return text(
          `Queued ${created.length} decision(s) as ${plan.id} "${title}":\n${keys.join("\n")}\nThe user answers them in \`dw tui\`; answers reach you with their next message.`,
        );
      } catch (error) {
        return failure(`Could not queue decisions: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "decision_list",
    {
      title: "List decisions",
      description: `List decisions of this project, compactly: open ones (with what they wait on) or decided ones with their answers and reasons. At most ${LIST_LIMIT} items.`,
      inputSchema: {
        status: z.enum(["open", "decided", "all"]).default("open").optional(),
      },
    },
    async ({ status = "open" }) => {
      try {
        const all = await client.call("decision.list", { project });
        const chosen =
          status === "open"
            ? queueOrder(all)
            : status === "decided"
              ? all.filter((d) => d.status === "decided")
              : all;
        if (chosen.length === 0)
          return text(`No ${status === "all" ? "" : `${status} `}decisions.`);
        const shown = chosen.slice(0, LIST_LIMIT).map(line);
        const more = chosen.length > LIST_LIMIT ? `\n…and ${chosen.length - LIST_LIMIT} more.` : "";
        return text(shown.join("\n") + more);
      } catch (error) {
        return failure((error as Error).message);
      }
    },
  );

  server.registerTool(
    "decision_get",
    {
      title: "Get one decision",
      description:
        "One decision in detail: question, options, answer and reason, prerequisites, and the latest Deep Dive summary.",
      inputSchema: { id: z.string().regex(/^D-\d+$/) },
    },
    async ({ id }) => {
      try {
        const { decision: d, explorations } = await client.call("decision.get", { project, id });
        const lines = [line(d)];
        for (const o of d.options) {
          const tags = [
            o.recommended ? "recommended" : "",
            o.source === "explorer" ? "proposed by Deep Dive" : "",
          ]
            .filter(Boolean)
            .join(", ");
          lines.push(
            `- ${o.label}${tags ? ` (${tags})` : ""}${o.description ? `: ${o.description}` : ""}`,
          );
        }
        if (d.dependsOn.length > 0)
          lines.push(`Depends on: ${d.dependsOn.map((x) => x.id).join(", ")}`);
        const latest = explorations.at(-1);
        if (latest) lines.push(`Deep Dive: ${latest.summary}`);
        if (isOpen(d)) lines.push("Not decided yet.");
        return text(lines.join("\n"));
      } catch (error) {
        return failure((error as Error).message);
      }
    },
  );

  return server;
}
