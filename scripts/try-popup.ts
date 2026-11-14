#!/usr/bin/env bun
/**
 * Ask questions the way the Claude Code hook does (route: true), so the project's mode decides
 * where they show: Workspace, Popup or "fallback". Development aid for T-603.
 *
 *   bun scripts/try-popup.ts [-p <project>] [two]
 *   (dw config set mode popup --local -p <project> to force the Popup)
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { DwClient, defaultSocketPath, findProjectRoot } from "@dw/ipc-client";
import type { AskQuestion } from "@dw/protocol";

const args = process.argv.slice(2);
const at = args.indexOf("-p");
const project = at >= 0 ? resolve(args[at + 1] ?? ".") : findProjectRoot(process.cwd());
const socketPath = defaultSocketPath();
const cli = join(import.meta.dir, "../apps/cli/src/main.ts");
const client = await DwClient.connect({
  socketPath,
  autoStart: () =>
    spawn(process.execPath, [cli, "daemon", "run", "--socket", socketPath], {
      detached: true,
      stdio: "ignore",
    }).unref(),
});
const questions: AskQuestion[] = [
  {
    question: "Where should notes be stored?",
    header: "Storage",
    options: [
      { label: "SQLite", description: "Local, works offline" },
      { label: "Cloud", description: "Shared across devices" },
    ],
  },
];
if (args.includes("two")) {
  questions.push({
    question: "Which features first?",
    header: "Scope",
    multiSelect: true,
    options: [{ label: "Sync" }, { label: "Search" }, { label: "Tags" }],
  });
}
console.error(`asking in ${project} …`);
const result = await client.call(
  "decision.askBatch",
  { project, batchId: `try-${Date.now()}`, sessionId: "try-popup", questions, route: true },
  { timeoutMs: 600_000 },
);
console.log(JSON.stringify(result, null, 2));
client.close();
