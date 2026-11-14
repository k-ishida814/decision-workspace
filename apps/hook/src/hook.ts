/**
 * Claude Code PreToolUse hook for AskUserQuestion (T-201, T-202).
 *
 * Sends the questions to the daemon and waits until they are answered in a UI, then returns
 * `permissionDecision: "allow"` with `updatedInput.answers` (verified in S-01).
 *
 * Fail-open (CC-03, CLAUDE.md): if anything is off — bad input, no daemon, no UI watching,
 * the user chose Claude Code's own UI — return nothing so Claude Code asks as usual.
 */
import { DwClient, findProjectRoot } from "@dw/ipc-client";
import { AskQuestion } from "@dw/protocol";
import { z } from "zod";

const HookInput = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  tool_name: z.string(),
  tool_use_id: z.string().optional(),
  tool_input: z.looseObject({ questions: z.array(AskQuestion).min(1) }),
});

export type HookOptions = {
  socketPath: string;
  /** Called if the answer doesn't come back right away (CC-08). */
  notify?: (count: number) => void;
  notifyAfterMs?: number;
  /** Debug output. Never receives question text (NFR-08). */
  log?: (message: string) => void;
};

/** Returns what to print on stdout, or undefined to print nothing. */
export async function runHook(raw: string, options: HookOptions): Promise<string | undefined> {
  const log = options.log ?? (() => {});
  let input: z.infer<typeof HookInput>;
  try {
    const parsed = HookInput.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log("not an AskUserQuestion call we understand; passing through");
      return undefined;
    }
    input = parsed.data;
  } catch {
    log("stdin is not JSON; passing through");
    return undefined;
  }
  if (input.tool_name !== "AskUserQuestion") return undefined;

  let client: DwClient;
  try {
    // No autoStart: a freshly started daemon has no UI, so nobody could answer anyway.
    client = await DwClient.connect({ socketPath: options.socketPath });
  } catch {
    log("daemon not running; passing through");
    return undefined;
  }

  const questions = input.tool_input.questions;
  const timer = setTimeout(() => options.notify?.(questions.length), options.notifyAfterMs ?? 300);
  try {
    const result = await client.call("decision.askBatch", {
      project: findProjectRoot(input.cwd ?? process.cwd()),
      batchId: input.tool_use_id ?? `${input.session_id ?? "session"}-${Date.now()}`,
      sessionId: input.session_id,
      questions,
      requireViewer: true,
    });
    log(`batch finished: ${result.status}`);
    switch (result.status) {
      case "answered":
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { ...input.tool_input, answers: result.answers },
          },
        });
      case "cancelled":
        // The user cancelled the question outright (skips arrive as "answered" with a note).
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "The user cancelled this question in Decision Workspace. Do not ask it again; proceed with a reasonable default and state the assumption you made.",
          },
        });
      case "fallback":
        return undefined;
    }
  } catch (error) {
    log(`daemon call failed (${(error as Error).name}); passing through`);
    return undefined;
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
