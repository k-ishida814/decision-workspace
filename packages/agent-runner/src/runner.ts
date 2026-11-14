/**
 * Runs one sub-agent as `claude -p` (T-307, ADR-0008). The transcript goes to disk; callers get
 * only the validated structured output and metrics (AG-04, AG-05).
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "@dw/protocol";
import { z } from "zod";

/** Read-only tools only (design D6): enough to research, nothing that changes the machine. */
export const AGENT_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch";

export type AgentSpec<T> = {
  kind: AgentKind;
  schema: z.ZodType<T>;
  /** Role and rules, appended to Claude Code's system prompt. */
  systemPrompt: string;
  /** The task. Untrusted text inside must already be wrapped in <data> tags (NFR-09). */
  prompt: string;
  /** Project root the agent may read. */
  cwd: string;
};

export type RunnerOptions = {
  model: string;
  maxBudgetUsd: number;
  maxTurns: number;
  /** Where transcripts are written (<runsDir>/<runId>.jsonl). */
  runsDir: string;
  runId: string;
  /** Command to start Claude Code. Tests pass a fake. Default: $DW_CLAUDE or "claude". */
  command?: string[];
  /** Hard stop for one attempt. Default 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Attempts when the output is missing or does not match the schema. Default 2. */
  attempts?: number;
};

export type RunMetrics = {
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  attempts: number;
  /** Tool calls by name, counted from the transcript (usage does not count WebSearch, S-03). */
  toolCalls: Record<string, number>;
  transcriptPath: string;
};

export type RunResult<T> =
  | { status: "succeeded"; output: T; metrics: RunMetrics }
  | { status: "failed" | "cancelled"; error: string; metrics: RunMetrics };

export function claudeArgs<T>(spec: AgentSpec<T>, o: RunnerOptions): string[] {
  return [
    "-p",
    spec.prompt,
    "--model",
    o.model,
    "--output-format",
    "stream-json",
    "--verbose",
    // Claude Code's validator does not know Zod's default draft 2020-12 (S-03).
    "--json-schema",
    JSON.stringify(z.toJSONSchema(spec.schema, { target: "draft-7" })),
    "--append-system-prompt",
    spec.systemPrompt,
    "--tools",
    AGENT_TOOLS,
    "--allowedTools",
    AGENT_TOOLS,
    "--max-turns",
    String(o.maxTurns),
    "--max-budget-usd",
    String(o.maxBudgetUsd),
    "--no-session-persistence",
    // Our own hooks and MCP server must not run inside the agent (ADR-0008).
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
  ];
}

type Attempt =
  | { kind: "result"; event: Record<string, unknown> }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

export async function runAgent<T>(spec: AgentSpec<T>, o: RunnerOptions): Promise<RunResult<T>> {
  mkdirSync(o.runsDir, { recursive: true });
  const transcriptPath = join(o.runsDir, `${o.runId}.jsonl`);
  const transcript = createWriteStream(transcriptPath, { flags: "a" });
  const metrics: RunMetrics = {
    durationMs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    attempts: 0,
    toolCalls: {},
    transcriptPath,
  };
  const started = Date.now();
  const command = o.command ?? (process.env.DW_CLAUDE ? [process.env.DW_CLAUDE] : ["claude"]);
  const maxAttempts = o.attempts ?? 2;
  let lastError = "no attempt was made";

  try {
    while (metrics.attempts < maxAttempts) {
      metrics.attempts++;
      const attempt = await runOnce(command, claudeArgs(spec, o), spec.cwd, o, transcript, metrics);
      if (attempt.kind === "cancelled") {
        return { status: "cancelled", error: "cancelled", metrics: done(metrics, started) };
      }
      if (attempt.kind === "error") {
        lastError = attempt.message;
        break; // process-level failure (crash, timeout, budget): retrying will not help
      }
      addUsage(metrics, attempt.event);
      if (attempt.event.is_error === true) {
        lastError = `claude reported an error (${String(attempt.event.subtype)})`;
        break;
      }
      if (!("structured_output" in attempt.event)) {
        lastError = "no structured output";
        continue;
      }
      const parsed = spec.schema.safeParse(attempt.event.structured_output);
      if (parsed.success)
        return { status: "succeeded", output: parsed.data, metrics: done(metrics, started) };
      const issue = parsed.error.issues[0];
      lastError = `output does not match the schema: ${issue?.path.join(".")} ${issue?.message}`;
    }
    return { status: "failed", error: lastError, metrics: done(metrics, started) };
  } finally {
    await new Promise<void>((r) => transcript.end(() => r()));
  }
}

function done(m: RunMetrics, started: number): RunMetrics {
  return { ...m, durationMs: Date.now() - started };
}

function addUsage(m: RunMetrics, event: Record<string, unknown>): void {
  const usage = (event.usage ?? {}) as Record<string, number | undefined>;
  m.costUsd += Number(event.total_cost_usd ?? 0);
  m.turns += Number(event.num_turns ?? 0);
  m.inputTokens +=
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  m.outputTokens += usage.output_tokens ?? 0;
}

async function runOnce(
  command: string[],
  args: string[],
  cwd: string,
  o: RunnerOptions,
  transcript: NodeJS.WritableStream,
  metrics: RunMetrics,
): Promise<Attempt> {
  if (o.signal?.aborted) return { kind: "cancelled" };
  const proc = Bun.spawn([...command, ...args], {
    cwd,
    // Pass the current environment explicitly: Bun.spawn does not see later process.env changes.
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, o.timeoutMs ?? 300_000);
  const onAbort = () => proc.kill("SIGTERM");
  o.signal?.addEventListener("abort", onAbort, { once: true });

  let result: Record<string, unknown> | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    transcript.write(`${line}\n`);
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "assistant") {
      const content = ((event.message as { content?: unknown[] })?.content ?? []) as {
        type?: string;
        name?: string;
      }[];
      for (const c of content) {
        if (c.type === "tool_use" && c.name)
          metrics.toolCalls[c.name] = (metrics.toolCalls[c.name] ?? 0) + 1;
      }
    }
    if (event.type === "result") result = event;
  };
  const [, stderr, exitCode] = await Promise.all([
    (async () => {
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      handleLine(buffer);
    })(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);

  if (o.signal?.aborted) return { kind: "cancelled" };
  if (timedOut) return { kind: "error", message: `timed out after ${o.timeoutMs ?? 300_000}ms` };
  if (result) return { kind: "result", event: result };
  const detail = stderr.trim().split("\n").at(-1) ?? "";
  return {
    kind: "error",
    message: `claude exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
  };
}

/** Limits how many agents run at once (design D7, config agents.concurrency). */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
