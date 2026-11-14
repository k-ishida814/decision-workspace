/**
 * `dw` command implementation (T-106, UI-06). `run` takes argv and an IO sink so tests can call
 * it in-process; main.ts only wires it to the real process.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  answerText,
  dependentsOf,
  overviewMermaid,
  overviewRows,
  overviewText,
  proposalKindLabel,
  queueOrder,
  statsText,
} from "@dw/core";
import { startDaemon } from "@dw/daemon";
import {
  ConfigError,
  configPath,
  DaemonUnavailableError,
  DwClient,
  defaultSocketPath,
  findProjectRoot,
  getConfigValue,
  loadConfig,
  RpcCallError,
  setConfigValue,
} from "@dw/ipc-client";
import type {
  AgentRun,
  Answer,
  Decision,
  DecisionStatus,
  Dependency,
  Exploration,
  NewDependency,
  Proposal,
  Revision,
} from "@dw/protocol";
import { CONFIG_KEYS, type ConfigKey, VERSION } from "@dw/protocol";
import {
  hasHook,
  hasMcp,
  hookCommand,
  MCP_NAME,
  mcpJsonPath,
  readSettings,
  settingsPath,
  withHook,
  withMcp,
  withMcpApproved,
  withoutHook,
  withoutMcp,
  withoutMcpApproved,
  writeSettings,
} from "./install";
import { selfCommand } from "./self";

export type Io = { out: (line: string) => void; err: (line: string) => void };

export type RunOptions = {
  cwd?: string;
  /** How to start the daemon when it is not running. Default: spawn `dw daemon run`. */
  autoStart?: (socketPath: string) => void;
};

const USAGE = `dw — Decision Workspace

Usage:
  dw tui                                answer decisions one at a time (keyboard UI)
  dw list [--all]                       open decisions in queue order (--all: every status)
  dw show <id>                          details and answer history
  dw add <question> [-o <option>]... [--multi] [--title <t>] [--no-other]
         [--after <id>[=<option>,...]]...
                                        no -o → free-text question; --after: prerequisite,
                                        optionally only when it was answered with those options
  dw diff <id>                          how the answer changed and what depends on it
  dw plan <request> [--detach]          Planner: an agent lists the decisions for a request,
                                        with dependencies (calls the model)
  dw review [--plan P-n] [--detach]     Reviewer: an agent checks the decided decisions for
                                        conflicts, answers to revisit and missing decisions
                                        (calls the model). Proposals only; nothing changes
  dw proposals [--all]                  open Reviewer proposals (--all: resolved ones too)
  dw accept|dismiss <RV-n>              apply a proposal (reopen / add a decision) or drop it
  dw stats                              agent runs, cost and tokens; context handed to Claude;
                                        decisions by status and origin
  dw graph [--plan P-n] [--format text|mermaid]
                                        every decision with its dependencies, conditions and
                                        answers (mermaid: paste into Markdown to draw it)
  dw explore <id> [--detach]            Deep Dive: an agent researches the options (calls the
                                        model; waits for the result unless --detach)
  dw answer <id> [<choice>...] [-t <text>] [-w <why>]
                                        choice = option number or label
  dw skip|cancel <id> [-w <why>]
  dw revisit <id>                       reopen a decided decision
  dw hold|unhold <id>                   put aside / bring back
  dw daemon run|status                  run the daemon in the foreground / check it
  dw config [get [<key>] | set <key> <value>]
                                        settings in ~/.decision-workspace/config.json
                                        (agents.model, agents.maxBudgetUsd, agents.maxTurns,
                                        agents.concurrency)
  dw install [--local] [--timeout <sec>] [--no-mcp]
                                        add the AskUserQuestion hook to .claude/settings.json
                                        (--local: settings.local.json, not committed) and the
                                        MCP server to .mcp.json
  dw uninstall [--local]                remove it again
  dw version                            print the version

Options:
  -p, --project <path>   project root (default: nearest .decision-workspace/.jj/.git)
      --socket <path>    daemon socket (default: $DW_SOCKET or ~/.decision-workspace/daemon.sock)
      --json             machine-readable output
  -h, --help`;

export async function run(
  argv: readonly string[],
  io: Io,
  options: RunOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err((error as Error).message);
    io.err("Run `dw --help` for usage.");
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.version) {
    io.out(VERSION);
    return 0;
  }
  if (values.help || !command) {
    io.out(USAGE);
    return command || values.help ? 0 : 2;
  }

  if (command === "version") {
    io.out(VERSION);
    return 0;
  }
  // What Claude Code runs (registered by dw install). Neither returns.
  if (command === "hook") {
    const { hookMain } = await import("@dw/hook/entry");
    return hookMain();
  }
  if (command === "mcp") {
    const { mcpMain } = await import("@dw/mcp/entry");
    return mcpMain(options.autoStart ?? spawnDaemon);
  }

  const socketPath = values.socket ?? defaultSocketPath();
  if (command === "daemon") return daemonCommand(args[0], socketPath, io);
  if (command === "config") return configCommand(args, values.json ?? false, io);

  const project = values.project
    ? resolve(values.project)
    : findProjectRoot(options.cwd ?? process.cwd());
  const autoStart = options.autoStart ?? spawnDaemon;
  if (command === "install" || command === "uninstall") {
    return installCommand(
      command,
      project,
      values.local ?? false,
      values.timeout,
      !values["no-mcp"],
      io,
    );
  }
  if (command === "tui") {
    // Loaded lazily so plain commands don't pay for the native TUI library.
    const { startTui } = await import("@dw/tui");
    await startTui({ socketPath, project, autoStart: () => autoStart(socketPath) });
    return 0;
  }
  let client: DwClient;
  try {
    client = await DwClient.connect({ socketPath, autoStart: () => autoStart(socketPath) });
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }

  const print = (value: unknown, human: () => void) =>
    values.json ? io.out(JSON.stringify(value, null, 2)) : human();

  try {
    switch (command) {
      case "list": {
        const all = await client.call("decision.list", { project });
        const shown = values.all ? all : queueOrder(all);
        print(shown, () => {
          if (shown.length === 0) io.out(values.all ? "no decisions" : "no open decisions");
          for (const d of shown) io.out(summaryLine(d));
        });
        return 0;
      }
      case "show": {
        const id = requireId(args);
        const { decision, revisions, explorations } = await client.call("decision.get", {
          project,
          id,
        });
        const all = await client.call("decision.list", { project });
        print({ decision, revisions, explorations }, () =>
          showDecision(decision, revisions, all, io, explorations),
        );
        return 0;
      }
      case "explore": {
        const id = requireId(args);
        // Subscribe first so a fast agent cannot finish before we listen.
        const finished = new Promise<AgentRun>((resolve) => {
          client.onRun((e) => {
            if (e.run.target === id && e.run.status !== "running") resolve(e.run);
          });
        });
        await client.call("events.subscribe", { project });
        const run = await client.call("decision.explore", { project, id });
        if (values.detach) {
          print(run, () =>
            io.out(`${run.id} started (Deep Dive on ${id}); dw show ${id} for the result`),
          );
          return 0;
        }
        if (!values.json) io.err(`Deep Dive on ${id} (${run.id}, ${run.model})...`);
        const done = await finished;
        const { decision, revisions, explorations } = await client.call("decision.get", {
          project,
          id,
        });
        print({ run: done, decision, explorations }, () => {
          if (done.status !== "succeeded") {
            io.out(`${done.id} ${done.status}: ${done.error ?? ""}`);
            return;
          }
          showDecision(decision, revisions, [decision], io, explorations);
          const seconds = ((done.durationMs ?? 0) / 1000).toFixed(1);
          io.out(`(${done.id}: ${seconds}s, USD ${(done.costUsd ?? 0).toFixed(3)})`);
        });
        return done.status === "succeeded" ? 0 : 1;
      }
      case "plan": {
        const request = args.join(" ").trim();
        if (!request) throw new UsageError('plan needs a request, e.g. dw plan "add sync"');
        let planId = "";
        const finished = new Promise<AgentRun>((resolve) => {
          client.onRun((e) => {
            if (e.run.kind === "planner" && e.run.target === planId && e.run.status !== "running") {
              resolve(e.run);
            }
          });
        });
        await client.call("events.subscribe", { project });
        const { plan, run } = await client.call("plan.generate", { project, request });
        planId = plan.id;
        if (values.detach) {
          print({ plan, run }, () =>
            io.out(`${plan.id} planning (${run.id}); dw graph --plan ${plan.id} later`),
          );
          return 0;
        }
        if (!values.json) io.err(`Planning ${plan.id} (${run.id}, ${run.model})...`);
        const done = await finished;
        const [all, plans] = await Promise.all([
          client.call("decision.list", { project }),
          client.call("plan.list", { project }),
        ]);
        print({ plan, run: done, decisions: all.filter((d) => d.planId === plan.id) }, () => {
          if (done.status !== "succeeded") {
            io.out(`${done.id} ${done.status}: ${done.error ?? ""}`);
            return;
          }
          io.out(overviewText(all, plans, plan.id));
          const seconds = ((done.durationMs ?? 0) / 1000).toFixed(1);
          io.out(
            `(${done.id}: ${seconds}s, USD ${(done.costUsd ?? 0).toFixed(3)}) answer them in dw tui`,
          );
        });
        return done.status === "succeeded" ? 0 : 1;
      }
      case "review": {
        const planId = values.plan;
        if (planId !== undefined && !/^P-\d+$/.test(planId)) {
          throw new UsageError(`--plan expects P-<n>, got "${planId}"`);
        }
        let runId = "";
        const finished = new Promise<AgentRun>((resolve) => {
          client.onRun((e) => {
            if (e.run.id === runId && e.run.status !== "running") resolve(e.run);
          });
        });
        await client.call("events.subscribe", { project });
        const run = await client.call("review.start", { project, planId });
        runId = run.id;
        if (values.detach) {
          print(run, () => io.out(`${run.id} reviewing; dw proposals for the result`));
          return 0;
        }
        if (!values.json)
          io.err(`Reviewing ${planId ?? "the project"} (${run.id}, ${run.model})...`);
        const done = await finished;
        const [proposals, all] = await Promise.all([
          client.call("review.list", { project, status: ["open"] }),
          client.call("decision.list", { project }),
        ]);
        const mine = proposals.filter((p) => p.runId === done.id);
        print({ run: done, proposals: mine }, () => {
          if (done.status !== "succeeded") {
            io.out(`${done.id} ${done.status}: ${done.error ?? ""}`);
            return;
          }
          if (mine.length === 0) io.out("no proposals: the decisions look consistent");
          for (const p of mine) showProposal(p, all, io);
          const seconds = ((done.durationMs ?? 0) / 1000).toFixed(1);
          io.out(
            `(${done.id}: ${seconds}s, USD ${(done.costUsd ?? 0).toFixed(3)})${mine.length > 0 ? " dw accept|dismiss <RV-n>, or a / x in dw tui History" : ""}`,
          );
        });
        return done.status === "succeeded" ? 0 : 1;
      }
      case "proposals": {
        const [proposals, all] = await Promise.all([
          client.call("review.list", { project, status: values.all ? undefined : ["open"] }),
          client.call("decision.list", { project }),
        ]);
        print(proposals, () => {
          if (proposals.length === 0) io.out(values.all ? "no proposals" : "no open proposals");
          for (const p of proposals) showProposal(p, all, io);
        });
        return 0;
      }
      case "accept":
      case "dismiss": {
        const [id] = args;
        if (!id || !/^RV-\d+$/.test(id))
          throw new UsageError(`${command} needs a proposal id (RV-n)`);
        const result = await client.call("review.resolve", {
          project,
          id,
          accept: command === "accept",
        });
        print(result, () => {
          if (command === "dismiss") return io.out(`${id} dismissed`);
          const ids = result.decisions.map((d) => d.id).join(", ");
          io.out(
            result.proposal.kind === "add"
              ? `${id} accepted: added ${ids}`
              : ids
                ? `${id} accepted: ${ids} reopened (revisit)`
                : `${id} accepted: nothing to reopen (already changed)`,
          );
        });
        return 0;
      }
      case "stats": {
        const stats = await client.call("stats.get", { project });
        print(stats, () => io.out(statsText(stats)));
        return 0;
      }
      case "graph": {
        const format = values.format ?? "text";
        if (format !== "text" && format !== "mermaid") {
          throw new UsageError("--format must be text or mermaid");
        }
        const planId = values.plan;
        if (planId !== undefined && !/^P-\d+$/.test(planId)) {
          throw new UsageError(`--plan expects P-<n>, got "${planId}"`);
        }
        const [all, plans] = await Promise.all([
          client.call("decision.list", { project }),
          client.call("plan.list", { project }),
        ]);
        if (values.json) {
          io.out(JSON.stringify({ plans, rows: overviewRows(all, planId) }, null, 2));
          return 0;
        }
        io.out(
          format === "mermaid"
            ? overviewMermaid(all, plans, planId)
            : overviewText(all, plans, planId),
        );
        return 0;
      }
      case "diff": {
        const id = requireId(args);
        const { decision, revisions } = await client.call("decision.get", { project, id });
        const all = await client.call("decision.list", { project });
        const affected = dependentsOf(id, all);
        print({ decision, revisions, affected }, () => showDiff(decision, revisions, affected, io));
        return 0;
      }
      case "add": {
        const question = args.join(" ").trim();
        if (!question) throw new UsageError("add needs a question");
        const labels = values.option ?? [];
        const dependsOn = await Promise.all(
          (values.after ?? []).map((spec) =>
            parseAfter(spec, (id) => client.call("decision.get", { project, id })),
          ),
        );
        const [d] = await client.call("decision.create", {
          project,
          decisions: [
            {
              question,
              dependsOn,
              title: values.title ?? "",
              kind: labels.length === 0 ? "text" : values.multi ? "multi" : "single",
              allowOther: !values["no-other"],
              options: labels.map((label, i) => ({ id: String(i + 1), label })),
            },
          ],
        });
        print(d, () => io.out(`added ${d?.id}${d?.status === "pending" ? " (waiting)" : ""}`));
        return 0;
      }
      case "answer": {
        const [id, ...choices] = args;
        if (!id) throw new UsageError("answer needs an id");
        const { decision } = await client.call("decision.get", { project, id });
        const answer = buildAnswer(decision, choices, values.text);
        const d = await client.call("decision.answer", {
          project,
          id,
          expectedVersion: decision.version,
          answer,
          rationale: values.why,
        });
        print(d, () => io.out(`${d.id} decided: ${answerText(d)}`));
        return 0;
      }
      case "skip":
      case "cancel":
      case "revisit": {
        const id = requireId(args);
        const to: DecisionStatus =
          command === "skip" ? "skipped" : command === "cancel" ? "cancelled" : "revisit";
        const { decision } = await client.call("decision.get", { project, id });
        const d = await client.call("decision.transition", {
          project,
          id,
          expectedVersion: decision.version,
          to,
          reason: values.why,
        });
        print(d, () => io.out(`${d.id} → ${d.status}`));
        return 0;
      }
      case "hold":
      case "unhold": {
        const id = requireId(args);
        const { decision } = await client.call("decision.get", { project, id });
        const d = await client.call("decision.hold", {
          project,
          id,
          expectedVersion: decision.version,
          held: command === "hold",
        });
        print(d, () => io.out(`${d.id} ${d.held ? "held" : "unheld"}`));
        return 0;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return 2;
    }
    if (error instanceof RpcCallError || error instanceof DaemonUnavailableError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  } finally {
    client.close();
  }
}

function showProposal(p: Proposal, all: readonly Decision[], io: Io): void {
  const name = (id: string) => {
    const d = all.find((x) => x.id === id);
    return d ? `${id} ${d.title || d.question}` : id;
  };
  const state = p.status === "open" ? "" : ` (${p.status})`;
  io.out(`${p.id} [${proposalKindLabel(p.kind)}] ${p.title}${state}`);
  io.out(`    ${p.reason}`);
  if (p.draft) {
    const options = p.draft.options.map((o) => o.label).join(" / ");
    io.out(`    add: ${p.draft.question}${options ? ` (${options})` : ""}`);
  }
  if (p.decisionIds.length > 0) {
    io.out(`    ${p.kind === "add" ? "after" : "reopen"}: ${p.decisionIds.map(name).join(", ")}`);
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      socket: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      all: { type: "boolean" },
      option: { type: "string", short: "o", multiple: true },
      multi: { type: "boolean" },
      title: { type: "string" },
      "no-other": { type: "boolean" },
      after: { type: "string", multiple: true },
      detach: { type: "boolean" },
      "no-mcp": { type: "boolean" },
      plan: { type: "string" },
      format: { type: "string" },
      text: { type: "string", short: "t" },
      why: { type: "string", short: "w" },
      local: { type: "boolean" },
      timeout: { type: "string" },
    },
  });
}

class UsageError extends Error {}

function requireId(args: readonly string[]): string {
  const id = args[0];
  if (!id) throw new UsageError("missing decision id");
  return id;
}

/** Choices may be option ids/numbers or labels (case-insensitive). Text-only decisions take words. */
export function buildAnswer(
  d: Decision,
  choices: readonly string[],
  text: string | undefined,
): Answer {
  if (d.kind === "text") {
    const value = text ?? choices.join(" ");
    return { selected: [], text: value };
  }
  const selected = choices.map((c) => {
    const byId = d.options.find((o) => o.id === c);
    const byLabel = d.options.find((o) => o.label.toLowerCase() === c.toLowerCase());
    const option = byId ?? byLabel;
    if (!option) throw new UsageError(`no option "${c}" in ${d.id}`);
    return option.id;
  });
  return text ? { selected, text } : { selected };
}

/** "D-1" or "D-1=cloud,2": options by id or label (case-insensitive). */
export async function parseAfter(
  spec: string,
  get: (id: string) => Promise<{ decision: Decision }>,
): Promise<NewDependency> {
  const [ref, list] = spec.split("=", 2) as [string, string | undefined];
  if (!/^D-\d+$/.test(ref)) throw new UsageError(`--after expects D-<n>[=options], got "${spec}"`);
  if (list === undefined) return { ref };
  const { decision } = await get(ref);
  const whenOptions = list.split(",").map((token) => {
    const t = token.trim();
    const option =
      decision.options.find((o) => o.id === t) ??
      decision.options.find((o) => o.label.toLowerCase() === t.toLowerCase());
    if (!option) throw new UsageError(`no option "${t}" in ${ref}`);
    return option.id;
  });
  return { ref, whenOptions };
}

function describeDependency(dep: Dependency, all: readonly Decision[]): string {
  const parent = all.find((d) => d.id === dep.id);
  const labels = dep.whenOptions?.map((o) => parent?.options.find((x) => x.id === o)?.label ?? o);
  return `${dep.id}${labels ? ` = ${labels.join(" / ")}` : ""}${parent ? ` (${parent.status})` : ""}`;
}

function summaryLine(d: Decision): string {
  const waiting =
    d.status === "pending" && d.dependsOn.length > 0
      ? `waiting: ${d.dependsOn.map((x) => x.id).join(", ")}`
      : "";
  const flags = [d.held ? "held" : "", d.kind === "multi" ? "multi" : "", waiting]
    .filter(Boolean)
    .join(",");
  const title = d.title ? `[${d.title}] ` : "";
  const answer = d.status === "decided" ? ` → ${answerText(d)}` : "";
  return `${d.id.padEnd(5)} ${d.status.padEnd(9)} ${flags ? `(${flags}) ` : ""}${title}${d.question}${answer}`;
}

function showDecision(
  d: Decision,
  revisions: readonly Revision[],
  all: readonly Decision[],
  io: Io,
  explorations: readonly Exploration[] = [],
): void {
  io.out(`${d.id}  ${d.status}${d.held ? " (held)" : ""}${d.title ? `  [${d.title}]` : ""}`);
  io.out(d.question);
  if (d.dependsOn.length > 0) {
    io.out(`after: ${d.dependsOn.map((dep) => describeDependency(dep, all)).join(", ")}`);
  }
  const children = all.filter((x) => x.dependsOn.some((dep) => dep.id === d.id));
  if (children.length > 0)
    io.out(`needed by: ${children.map((x) => `${x.id} (${x.status})`).join(", ")}`);
  for (const o of d.options) {
    const mark = d.answer?.selected.includes(o.id) ? "●" : "○";
    const tags = `${o.recommended ? " *recommended" : ""}${o.source === "explorer" ? " (proposed)" : ""}`;
    io.out(`  ${mark} ${o.id}. ${o.label}${tags}${o.description ? ` — ${o.description}` : ""}`);
  }
  const recommended = d.options.find((o) => o.recommended);
  if (recommended?.reason) io.out(`recommended: ${recommended.label} — ${recommended.reason}`);
  const latest = explorations.at(-1);
  if (latest) {
    io.out(`deep dive (${latest.runId}): ${latest.summary}`);
    for (const t of latest.tradeoffs) {
      const label = d.options.find((o) => o.id === t.optionId)?.label ?? t.optionId;
      io.out(`  ${label}: pros ${t.pros.join(" / ") || "-"}; cons ${t.cons.join(" / ") || "-"}`);
    }
  }
  if (d.answer) io.out(`answer: ${answerText(d)}`);
  if (d.rationale) io.out(`why: ${d.rationale}`);
  if (d.closedReason) io.out(`reason: ${d.closedReason}`);
  if (revisions.length > 1) {
    io.out("history:");
    for (const r of revisions) {
      const labels = r.answer.selected.map((id) => d.options.find((o) => o.id === id)?.label ?? id);
      const value = [labels.join(", "), r.answer.text].filter(Boolean).join(" / ");
      io.out(`  #${r.revision} ${r.createdAt}  ${value}${r.rationale ? `  (${r.rationale})` : ""}`);
    }
  }
}

/** DG-05: the last change of an answer, and the decisions that depend on it. */
function showDiff(
  d: Decision,
  revisions: readonly Revision[],
  affected: readonly Decision[],
  io: Io,
): void {
  const text = (r: Revision | undefined) => {
    if (!r) return "(none)";
    const labels = r.answer.selected.map((id) => d.options.find((o) => o.id === id)?.label ?? id);
    return [labels.join(", "), r.answer.text].filter(Boolean).join(" / ");
  };
  io.out(`${d.id}  ${d.question}  (${d.status})`);
  const last = revisions.at(-1);
  const before = revisions.at(-2);
  if (!last) io.out("  not answered yet");
  else if (!before) io.out(`  #1: ${text(last)}`);
  else {
    io.out(`  #${before.revision} → #${last.revision}: ${text(before)} → ${text(last)}`);
    if (last.rationale) io.out(`  why: ${last.rationale}`);
  }
  if (d.status === "revisit") io.out("  (being reconsidered: the last answer is shown)");
  if (affected.length === 0) {
    io.out("affects: nothing");
    return;
  }
  io.out("affects:");
  for (const a of affected) {
    const reason = a.closedReason ? ` (${a.closedReason})` : "";
    io.out(`  ${a.id.padEnd(5)} ${a.status.padEnd(9)} ${a.question}${reason}`);
  }
}

function configCommand(args: readonly string[], json: boolean, io: Io): number {
  const [sub = "get", key, value] = args;
  try {
    if (sub === "get") {
      const config = loadConfig();
      if (key) {
        if (!(key in CONFIG_KEYS)) throw new ConfigError(`unknown key "${key}"`);
        const v = getConfigValue(config, key as ConfigKey);
        io.out(json ? JSON.stringify(v) : String(v));
        return 0;
      }
      if (json) io.out(JSON.stringify(config, null, 2));
      else
        for (const k of Object.keys(CONFIG_KEYS))
          io.out(`${k} = ${getConfigValue(config, k as ConfigKey)}`);
      return 0;
    }
    if (sub === "set") {
      if (!key || value === undefined) throw new UsageError("usage: dw config set <key> <value>");
      setConfigValue(key, value);
      io.out(`${key} = ${value}  (${configPath()})`);
      return 0;
    }
    throw new UsageError("usage: dw config [get [<key>] | set <key> <value>]");
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return 2;
    }
    if (error instanceof ConfigError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function daemonCommand(sub: string | undefined, socketPath: string, io: Io): Promise<number> {
  if (sub === "run") {
    const daemon = await startDaemon({ socketPath, log: (m) => io.err(`[dw daemon] ${m}`) });
    await new Promise<void>((done) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done());
    });
    await daemon.close();
    return 0;
  }
  if (sub === "status") {
    try {
      const client = await DwClient.connect({ socketPath });
      const { pid, version } = await client.call("daemon.ping", {});
      client.close();
      io.out(`running (pid ${pid}, v${version}) on ${socketPath}`);
      return 0;
    } catch {
      io.out(`not running (${socketPath})`);
      return 1;
    }
  }
  io.err("usage: dw daemon run|status");
  return 2;
}

function installCommand(
  command: "install" | "uninstall",
  project: string,
  local: boolean,
  timeout: string | undefined,
  mcp: boolean,
  io: Io,
): number {
  const path = settingsPath(project, local);
  const mcpPath = mcpJsonPath(project);
  let settings: ReturnType<typeof readSettings>;
  let mcpJson: ReturnType<typeof readSettings>;
  try {
    settings = readSettings(path);
    mcpJson = readSettings(mcpPath);
  } catch (error) {
    io.err(`cannot read settings: ${(error as Error).message}`);
    return 1;
  }
  if (command === "uninstall") {
    if (!hasHook(settings) && !hasMcp(mcpJson)) {
      io.out(`not installed in ${path}`);
      return 0;
    }
    writeSettings(path, withoutMcpApproved(withoutHook(settings)));
    io.out(`removed the hook from ${path}`);
    if (hasMcp(mcpJson)) {
      writeSettings(mcpPath, withoutMcp(mcpJson));
      io.out(`removed the MCP server from ${mcpPath}`);
    }
    return 0;
  }
  const seconds = timeout === undefined ? 600 : Number(timeout);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    io.err("--timeout must be a positive number of seconds");
    return 2;
  }
  const self = selfCommand();
  let next = withHook(settings, hookCommand(self), seconds);
  if (mcp) next = withMcpApproved(next);
  writeSettings(path, next);
  io.out(`installed the hook in ${path}`);
  if (mcp) {
    writeSettings(mcpPath, withMcp(mcpJson, self));
    io.out(
      `installed the MCP server "${MCP_NAME}" in ${mcpPath} (contains absolute paths of this machine)`,
    );
  }
  io.out("Restart Claude Code in this project, and keep `dw tui` open to answer questions there.");
  return 0;
}

/** Start `dw daemon run` detached so it outlives this command. */
function spawnDaemon(socketPath: string): void {
  const [command, ...args] = selfCommand();
  const child = spawn(command as string, [...args, "daemon", "run", "--socket", socketPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
