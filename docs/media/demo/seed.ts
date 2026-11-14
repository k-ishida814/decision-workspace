#!/usr/bin/env bun
/**
 * Demo data for the vhs tapes. Talks to the demo daemon (DW_SOCKET from env.sh).
 *   seed.ts ask      Claude Code asks two questions, the way the hook does (after a short delay)
 *   seed.ts plan     a plan with conditional dependencies, partly answered
 *   seed.ts explore  one open decision to Deep Dive on
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DwClient, defaultSocketPath, findProjectRoot } from "@dw/ipc-client";

const what = process.argv[2];
const project = findProjectRoot(process.cwd());
const socketPath = defaultSocketPath();
const cli = join(import.meta.dir, "../../../apps/cli/src/main.ts");
const c = await DwClient.connect({
  socketPath,
  autoStart: () =>
    spawn(process.execPath, [cli, "daemon", "run", "--socket", socketPath], {
      detached: true,
      stdio: "ignore",
    }).unref(),
});

if (what === "ask") {
  await Bun.sleep(Number(process.env.DEMO_DELAY_MS ?? 1500));
  await c.call(
    "decision.askBatch",
    {
      project,
      batchId: "toolu_demo",
      sessionId: "3f9c2a71-demo",
      route: true,
      questions: [
        {
          header: "Storage",
          question: "Where should the notes be stored?",
          options: [
            { label: "SQLite", description: "One local file, fast, works offline" },
            { label: "Plain Markdown files", description: "Readable in any editor" },
            { label: "iCloud (CloudKit)", description: "Synced across the user's devices" },
          ],
        },
        {
          header: "Features",
          question: "Which features go into the first release?",
          multiSelect: true,
          options: [
            { label: "Full-text search" },
            { label: "Tags" },
            { label: "Attachments" },
            { label: "Export to PDF" },
          ],
        },
      ],
    },
    { timeoutMs: 600_000 },
  );
} else if (what === "plan") {
  const { decisions } = await c.call("plan.create", {
    project,
    request: "Sync notes across the user's Macs",
    source: "claude",
    decisions: [
      {
        key: "storage",
        title: "Storage",
        question: "Where do the notes live?",
        kind: "single",
        options: [
          { id: "1", label: "Local only" },
          { id: "2", label: "Cloud" },
        ],
      },
      {
        key: "sync",
        title: "Sync",
        question: "How do devices sync?",
        kind: "single",
        dependsOn: [{ ref: "storage", whenOptions: ["2"] }],
        options: [
          { id: "1", label: "Real-time" },
          { id: "2", label: "On demand" },
        ],
      },
      {
        key: "conflicts",
        title: "Conflicts",
        question: "What happens when two edits collide?",
        kind: "single",
        dependsOn: [{ ref: "sync" }],
        options: [
          { id: "1", label: "Last write wins" },
          { id: "2", label: "Keep both copies" },
        ],
      },
      {
        key: "backup",
        title: "Backup",
        question: "How are local notes backed up?",
        kind: "single",
        dependsOn: [{ ref: "storage", whenOptions: ["1"] }],
        options: [
          { id: "1", label: "Time Machine" },
          { id: "2", label: "Export to a folder" },
        ],
      },
    ],
  });
  // Answer storage = Cloud, sync = Real-time, conflicts = Last write wins.
  for (const [i, choice, why] of [
    [0, "2", "users have a laptop and a desktop"],
    [1, "1", ""],
    [2, "1", ""],
  ] as const) {
    const d = (await c.call("decision.get", { project, id: decisions[i]?.id ?? "" })).decision;
    await c.call("decision.answer", {
      project,
      id: d.id,
      expectedVersion: d.version,
      answer: { selected: [choice] },
      rationale: why || undefined,
    });
  }
} else if (what === "explore") {
  await c.call("decision.create", {
    project,
    decisions: [
      {
        title: "Search",
        question: "How should full-text search work?",
        kind: "single",
        options: [
          { id: "1", label: "SQLite FTS5" },
          { id: "2", label: "Core Spotlight" },
          { id: "3", label: "Scan files on every search" },
        ],
      },
    ],
  });
} else {
  console.error("usage: seed.ts ask|plan|explore");
  process.exit(2);
}
c.close();
process.exit(0);
