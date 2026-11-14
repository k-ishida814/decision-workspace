/**
 * What Claude Code runs (`dw hook`, or `bun apps/hook/src/main.ts` in development). Always exits
 * 0: a hook error must never block Claude Code. When Claude Code gives up (Esc / timeout) it sends
 * SIGTERM; exiting closes the socket and the daemon withdraws the questions (ADR-0004).
 */
import { spawn } from "node:child_process";
import { defaultSocketPath } from "@dw/ipc-client";
import { runHook } from "./hook";
import { runPromptHook } from "./prompt";

function notify(count: number): void {
  if (process.platform !== "darwin" || process.env.DW_NOTIFY === "0") return;
  const plural = count === 1 ? "" : "s";
  const script = `display notification "Claude Code asked ${count} question${plural}" with title "Decision Workspace" sound name "Glass"`;
  spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
}

/** @param startDaemon how to start the daemon when the Popup can show a question */
export async function hookMain(startDaemon?: (socketPath: string) => void): Promise<never> {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => process.exit(0));
  const debug = process.env.DW_HOOK_DEBUG === "1";
  try {
    const raw = await Bun.stdin.text();
    const log = debug ? (m: string) => console.error(`[dw hook] ${m}`) : undefined;
    const output = /"hook_event_name"\s*:\s*"UserPromptSubmit"/.test(raw)
      ? await runPromptHook(raw, { socketPath: defaultSocketPath(), log })
      : await runHook(raw, { socketPath: defaultSocketPath(), notify, log, startDaemon });
    if (output) process.stdout.write(output);
  } catch (error) {
    if (debug) console.error(`[dw hook] unexpected: ${(error as Error).message}`);
  }
  process.exit(0);
}
