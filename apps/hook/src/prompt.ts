/**
 * UserPromptSubmit hook (T-312, CC-09): add decisions made since the last message to Claude's
 * context. Runs before every prompt, so it must be fast and fail open: no daemon, a slow daemon
 * or bad input means no context, never a blocked prompt.
 */
import { DwClient, findProjectRoot } from "@dw/ipc-client";
import { z } from "zod";

const PromptInput = z.object({
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  hook_event_name: z.literal("UserPromptSubmit"),
});

export type PromptHookOptions = {
  socketPath: string;
  /** Give up after this long so the prompt is never held up (default 2 s). */
  timeoutMs?: number;
  log?: (message: string) => void;
};

export async function runPromptHook(
  raw: string,
  options: PromptHookOptions,
): Promise<string | undefined> {
  const log = options.log ?? (() => {});
  let input: z.infer<typeof PromptInput>;
  try {
    const parsed = PromptInput.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    input = parsed.data;
  } catch {
    return undefined;
  }
  let client: DwClient;
  try {
    client = await DwClient.connect({ socketPath: options.socketPath });
  } catch {
    log("daemon not running; no context added");
    return undefined;
  }
  try {
    const { text, delivered } = await client.call(
      "delivery.take",
      { project: findProjectRoot(input.cwd ?? process.cwd()), sessionId: input.session_id },
      { timeoutMs: options.timeoutMs ?? 2000 },
    );
    log(`delivered ${delivered} decision(s)`);
    if (!text) return undefined;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    });
  } catch (error) {
    log(`daemon call failed (${(error as Error).name}); no context added`);
    return undefined;
  } finally {
    client.close();
  }
}
