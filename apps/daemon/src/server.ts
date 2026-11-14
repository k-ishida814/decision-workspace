/**
 * The daemon (T-104): the only writer of every project's database (ADR-0003), serving
 * JSON-RPC over a Unix domain socket (ADR-0004).
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type AgentSpec,
  explorerSpec,
  plannerSpec,
  reviewerSpec,
  runAgent,
  Semaphore,
} from "@dw/agent-runner";
import {
  batchOutcome,
  computeStats,
  DISCONNECT_REASON,
  DomainError,
  type DraftDecision,
  FALLBACK_REASON,
  formatDelivery,
  fromAddProposal,
  fromAskQuestions,
  fromDrafts,
  isOpen,
  NO_VIEWER_REASON,
  popupShow,
  proposalsFrom,
  type Route,
  routeFor,
  toReopen,
} from "@dw/core";
import { canonicalPath, encode, LineDecoder, loadConfig, resolveMode } from "@dw/ipc-client";
import {
  type AgentRun,
  type AskBatchResult,
  type Config,
  DEFAULT_CONFIG,
  type Decision,
  type DwEvent,
  ErrorCode,
  type MethodName,
  methods,
  type Plan,
  type ResultOf,
  type RpcRequest,
  type RunEvent,
  type UiMode,
  VERSION,
} from "@dw/protocol";
import { dbPathFor, Store, StoreError } from "@dw/storage";
import { type PopupJob, PopupQueue, type PopupResult } from "./popup";

export const DAEMON_VERSION = VERSION;

export { DISCONNECT_REASON } from "@dw/core";

export type DaemonOptions = {
  socketPath: string;
  now?: () => string;
  /** Override where a project's DB lives (tests). */
  dbPath?: (project: string) => string;
  log?: (message: string) => void;
  /** How to start Claude Code for agents (tests pass a fake). Default: $DW_CLAUDE or "claude". */
  claudeCommand?: string[];
  /** Agent settings (CF-01). Default: read ~/.decision-workspace/config.json on every run. */
  config?: () => Config;
  /**
   * Where a project's questions go (T-601). Default: the project override, else the user
   * config, read on every question.
   */
  mode?: (project: string) => UiMode;
  /** How to start the Popup. Default: $DW_POPUP, else `dw-popup` next to this executable. */
  popupCommand?: () => string[] | undefined;
  /** How long a Popup may take to appear before the question falls back. Default 5 s. */
  popupShownTimeoutMs?: number;
};

export type Daemon = { close: () => Promise<void>; socketPath: string };

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Waiter = {
  project: string;
  batchId: string;
  socket: Socket;
  respond: (result: AskBatchResult) => void;
  /** Hand the batch back when the last Workspace for the project closes. */
  requireViewer: boolean;
};

/**
 * $DW_POPUP, else the Popup shipped next to the dw binary (Homebrew), else a development build
 * in this repository (bun run build:popup).
 */
function defaultPopupCommand(): string[] | undefined {
  if (process.env.DW_POPUP) return [process.env.DW_POPUP];
  const candidates = [
    join(dirname(process.execPath), "dw-popup"),
    join(import.meta.dir, "../../popup/src-tauri/target/release/dw-popup"),
  ];
  const found = candidates.find((c) => existsSync(c));
  return found ? [found] : undefined;
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const now = options.now ?? (() => new Date().toISOString());
  const dbPath = options.dbPath ?? dbPathFor;
  const log = options.log ?? (() => {});
  const stores = new Map<string, Store>();
  const subscribers = new Map<Socket, string | undefined>(); // socket → project filter
  const waiters = new Set<Waiter>();
  const sockets = new Set<Socket>();
  // A broken config file must not stop the daemon (and with it every hook): fall back to defaults.
  const config = (): Config => {
    try {
      return (options.config ?? loadConfig)();
    } catch (error) {
      log(`config ignored: ${(error as Error).message}`);
      return DEFAULT_CONFIG;
    }
  };
  const agents = new Semaphore(config().agents.concurrency);
  /** Running agents: cancel handle and the promise that finishes them. */
  const running = new Map<
    string,
    { project: string; controller: AbortController; done: Promise<void> }
  >();

  function publishRun(project: string, run: AgentRun): void {
    const params: RunEvent = { project: canonicalPath(project), run };
    for (const [socket, filter] of subscribers) {
      if (!filter || canonicalPath(filter) === params.project) {
        socket.write(encode({ jsonrpc: "2.0", method: "run", params }));
      }
    }
  }

  /**
   * Run one agent in the background (T-307): record it, respect the concurrency limit, apply the
   * result, and announce start and end. `apply` runs only on success; if it throws (e.g. the
   * Planner produced a cycle) the run is recorded as failed with that message.
   */
  function startAgent<T>(
    project: string,
    kind: AgentRun["kind"],
    target: string,
    spec: () => AgentSpec<T>,
    apply: (output: T, runId: string) => void,
    onFailure: (error: string) => void = () => {},
  ): AgentRun {
    const s = store(project);
    const root = canonicalPath(project);
    const settings = config().agents;
    const run = s.startRun({ kind, target, model: settings.model }, now());
    publishRun(project, run);
    const controller = new AbortController();
    const done = agents
      .use(async () => {
        const result = await runAgent(spec(), {
          model: settings.model,
          maxBudgetUsd: settings.maxBudgetUsd,
          maxTurns: settings.maxTurns,
          runsDir: join(dirname(dbPath(root)), "runs"),
          runId: run.id,
          command: options.claudeCommand,
          signal: controller.signal,
        });
        let status = result.status;
        let error = result.status === "succeeded" ? undefined : result.error;
        if (result.status === "succeeded") {
          try {
            apply(result.output, run.id);
          } catch (e) {
            status = "failed";
            error = `result could not be applied: ${(e as Error).message}`;
          }
        }
        if (status !== "succeeded") onFailure(error ?? status);
        const finished = s.finishRun(run.id, {
          status,
          durationMs: result.metrics.durationMs,
          costUsd: result.metrics.costUsd,
          inputTokens: result.metrics.inputTokens,
          outputTokens: result.metrics.outputTokens,
          transcriptPath: result.metrics.transcriptPath,
          error,
        });
        log(`${kind} ${run.id} for ${target}: ${finished.status}`);
        flush(project);
        publishRun(project, finished);
      })
      .catch((error) => log(`${kind} ${run.id} crashed: ${(error as Error).message}`))
      .finally(() => running.delete(run.id));
    running.set(run.id, { project: root, controller, done });
    return run;
  }

  /** Deep Dive (T-308): the Explorer researches one decision; its result is merged. */
  function startExplorer(project: string, decision: Decision): AgentRun {
    const s = store(project);
    return startAgent(
      project,
      "explorer",
      decision.id,
      () => explorerSpec(s.get(decision.id) ?? decision, s.list(), canonicalPath(project)),
      (output, runId) => s.applyExploration(decision.id, runId, output, now()),
    );
  }

  /** T-309: the Planner turns a request into a plan; the decisions arrive when it finishes. */
  function startPlanner(project: string, plan: Plan): AgentRun {
    const s = store(project);
    return startAgent(
      project,
      "planner",
      plan.id,
      () => plannerSpec(plan.request, s.list(), canonicalPath(project)),
      (output) => {
        s.db.transaction(() => {
          const drafts: DraftDecision[] = output.decisions.map((d) => ({
            ...d,
            dependsOn: d.dependsOn.map((x) => ({ ref: x.ref, whenOptions: x.whenOptions })),
          }));
          const created = s.create(
            fromDrafts(drafts, new Map(), "claude").map((d) => ({
              ...d,
              origin: "plan" as const,
              planId: plan.id,
            })),
            now(),
          );
          s.setPlanStatus(plan.id, "ready");
          publish(project, "decision.created", created);
        })();
      },
      () => s.setPlanStatus(plan.id, "failed"),
    );
  }

  /** T-310: the Reviewer checks the decided decisions of a plan or the project; proposals only. */
  function startReviewer(project: string, target: string): AgentRun {
    const s = store(project);
    const scope = () =>
      target === "project" ? s.list() : s.list().filter((d) => d.planId === target);
    return startAgent(
      project,
      "reviewer",
      target,
      () => reviewerSpec(scope(), canonicalPath(project)),
      (output, runId) => {
        s.addProposals(runId, target, proposalsFrom(output.proposals, s.list()), now());
      },
    );
  }

  function modeFor(project: string): UiMode {
    try {
      return (options.mode ?? ((p: string) => resolveMode(p).mode))(canonicalPath(project));
    } catch (error) {
      log(`mode ignored: ${(error as Error).message}`);
      return "workspace";
    }
  }

  const popups = new PopupQueue({
    command: options.popupCommand ?? defaultPopupCommand,
    shownTimeoutMs: options.popupShownTimeoutMs ?? 5000,
    log,
    show: (job, more) => {
      const batch = store(job.project).byBatch(job.batchId);
      const first = batch[0];
      return popupShow(
        batch,
        {
          project: basename(job.project),
          session: first?.sessionId?.slice(0, 8),
          at: first?.createdAt ?? now(),
        },
        more,
        hasViewer(job.project),
      );
    },
    done: (job, result) => popupDone(job, result),
  });

  /** Apply what the Popup returned; anything that cannot be applied falls back (T-602). */
  function popupDone(job: PopupJob, result: PopupResult): void {
    const s = store(job.project);
    if (result.type === "toWorkspace") {
      const w = [...waiters].find((x) => x.project === job.project && x.batchId === job.batchId);
      if (w && hasViewer(job.project)) {
        w.requireViewer = true; // now the Workspace's: hand back if it closes
        return;
      }
    }
    if (result.type === "answer") {
      try {
        s.tx(() => {
          for (const a of result.answers) {
            const d = s.get(a.id);
            if (!d || d.batchId !== job.batchId || !isOpen(d)) continue;
            if ("skipped" in a) s.transition(d.id, d.version, "skipped", "user", now());
            else
              s.answer(d.id, d.version, { selected: a.selected, text: a.text }, undefined, now());
          }
        });
      } catch (error) {
        log(`popup answer for ${job.batchId} rejected: ${(error as Error).message}`);
      }
      flush(job.project);
      if (batchOutcome(s.byBatch(job.batchId))) return;
    }
    s.cancelBatch(job.batchId, FALLBACK_REASON, now());
    flush(job.project);
  }

  function store(project: string): Store {
    if (!isAbsolute(project))
      throw new RpcFailure(ErrorCode.InvalidParams, "project must be an absolute path");
    const key = canonicalPath(project);
    let s = stores.get(key);
    if (!s) {
      try {
        s = new Store(dbPath(key));
      } catch (error) {
        throw new RpcFailure(
          ErrorCode.Internal,
          `cannot open ${dbPath(key)}: ${(error as Error).message}`,
        );
      }
      // Agents run as children of the daemon; any left "running" died with a previous daemon.
      s.abandonRunningRuns("daemon restarted");
      stores.set(key, s);
    }
    return s;
  }

  /** Publish everything the store changed, including decisions the graph moved (DG-03). */
  function flush(project: string): void {
    publish(project, "decision.updated", store(project).takeChanges());
  }

  /** Is some UI (TUI / VS Code) subscribed to this project's events? */
  function hasViewer(project: string): boolean {
    const key = canonicalPath(project);
    for (const filter of subscribers.values())
      if (!filter || canonicalPath(filter) === key) return true;
    return false;
  }

  function publish(project: string, type: DwEvent["type"], decisions: readonly Decision[]): void {
    for (const decision of decisions) {
      const event: DwEvent = { type, project: canonicalPath(project), decision };
      for (const [socket, filter] of subscribers) {
        if (!filter || canonicalPath(filter) === event.project) {
          socket.write(encode({ jsonrpc: "2.0", method: "event", params: event }));
        }
      }
    }
    settleWaiters(project, decisions);
    // A batch settled elsewhere (Workspace, CLI, Claude Code withdrew it): close its Popup.
    const key = canonicalPath(project);
    for (const batchId of new Set(decisions.map((d) => d.batchId).filter(Boolean))) {
      const job = { project: key, batchId: batchId as string };
      if (popups.has(job) && batchOutcome(store(project).byBatch(job.batchId))) {
        popups.withdraw(job);
      }
    }
  }

  /** Answer any hook waiting on a batch that just finished. */
  function settleWaiters(project: string, changed: readonly Decision[]): void {
    const batches = new Set(changed.map((d) => d.batchId).filter((b): b is string => Boolean(b)));
    for (const w of [...waiters]) {
      if (w.project !== canonicalPath(project) || !batches.has(w.batchId)) continue;
      const outcome = batchOutcome(store(project).byBatch(w.batchId));
      if (outcome) {
        waiters.delete(w);
        w.respond(outcome);
      }
    }
  }

  type Handler<M extends MethodName> = (
    params: ParsedParams<M>,
    socket: Socket,
    respondLater: (result: ResultOf<M>) => void,
  ) => ResultOf<M> | typeof LATER;

  const handlers: { [M in MethodName]: Handler<M> } = {
    "daemon.ping": () => ({ pid: process.pid, version: DAEMON_VERSION }),

    "decision.create": (p) => {
      const created = store(p.project).create(p.decisions, now());
      publish(p.project, "decision.created", created);
      return created;
    },

    "decision.askBatch": (p, socket, respondLater) => {
      // Workspace, Popup, or straight back to Claude Code's own UI (design/ui-modes.md §3).
      const route: Route | undefined = p.route
        ? routeFor(modeFor(p.project), hasViewer(p.project))
        : undefined;
      if (route === "fallback") return { status: "fallback" as const };
      const s = store(p.project);
      // Claude Code may fire PreToolUse again for the same tool_use_id (e.g. on resume):
      // reuse the existing decisions instead of asking twice.
      let batch = s.byBatch(p.batchId);
      if (batch.length === 0) {
        batch = s.create(fromAskQuestions(p.questions, p.batchId, p.sessionId), now());
        publish(p.project, "decision.created", batch);
      }
      const outcome = batchOutcome(batch);
      if (outcome) return outcome;
      waiters.add({
        project: canonicalPath(p.project),
        batchId: p.batchId,
        socket,
        respond: respondLater,
        requireViewer: route === "workspace",
      });
      if (route === "popup")
        popups.enqueue({ project: canonicalPath(p.project), batchId: p.batchId });
      return LATER;
    },

    "decision.list": (p) => store(p.project).list(p.status),

    "decision.get": (p) => {
      const s = store(p.project);
      const decision = s.get(p.id);
      if (!decision) throw new StoreError("NotFound", `decision ${p.id} not found`);
      return { decision, revisions: s.revisions(p.id), explorations: s.explorations(p.id) };
    },

    "decision.explore": (p) => {
      const s = store(p.project);
      const decision = s.get(p.id);
      if (!decision) throw new StoreError("NotFound", `decision ${p.id} not found`);
      if (!isOpen(decision)) {
        throw new RpcFailure(
          ErrorCode.InvalidTransition,
          `${p.id} is ${decision.status}; nothing to explore`,
        );
      }
      if (s.runs(p.id).some((r) => r.status === "running")) {
        throw new RpcFailure(ErrorCode.AgentBusy, `a Deep Dive for ${p.id} is already running`);
      }
      return startExplorer(p.project, decision);
    },

    "plan.create": (p) => {
      const s = store(p.project);
      // One transaction: a plan never exists without its decisions.
      const result = s.db.transaction(() => {
        const plan = s.createPlan(
          { request: p.request, source: p.source, sessionId: p.sessionId, status: "ready" },
          now(),
        );
        const decisions = s.create(
          p.decisions.map((d) => ({
            ...d,
            origin: "plan" as const,
            planId: plan.id,
            sessionId: p.sessionId,
          })),
          now(),
        );
        return { plan, decisions };
      })();
      publish(p.project, "decision.created", result.decisions);
      return result;
    },

    "plan.list": (p) => store(p.project).plans(),

    "plan.generate": (p) => {
      const plan = store(p.project).createPlan(
        { request: p.request, source: "user", status: "planning" },
        now(),
      );
      return { plan, run: startPlanner(p.project, plan) };
    },

    "review.start": (p) => {
      const s = store(p.project);
      const target = p.planId ?? "project";
      const scope = p.planId ? s.list().filter((d) => d.planId === p.planId) : s.list();
      if (!scope.some((d) => d.status === "decided")) {
        throw new RpcFailure(
          ErrorCode.InvalidTransition,
          `nothing decided ${p.planId ? `in ${p.planId} ` : ""}yet; answer some decisions first`,
        );
      }
      if (s.runs().some((r) => r.kind === "reviewer" && r.status === "running")) {
        throw new RpcFailure(ErrorCode.AgentBusy, "a review is already running");
      }
      return startReviewer(p.project, target);
    },

    "review.list": (p) => store(p.project).proposals(p.status),

    "review.resolve": (p) => {
      const s = store(p.project);
      // One transaction: the proposal is accepted only if applying it worked.
      const result = s.tx(() => {
        const proposal = s.resolveProposal(p.id, p.accept ? "accepted" : "dismissed", now());
        if (!p.accept) return { proposal, decisions: [] as Decision[], created: false };
        const all = s.list();
        if (proposal.kind === "add") {
          return {
            proposal,
            decisions: s.create([fromAddProposal(proposal, all)], now()),
            created: true,
          };
        }
        const reopened = toReopen(proposal, all).map((d) =>
          s.transition(d.id, d.version, "revisit", `review ${proposal.id}`, now()),
        );
        return { proposal, decisions: reopened, created: false };
      });
      if (result.created) publish(p.project, "decision.created", result.decisions);
      flush(p.project);
      return { proposal: result.proposal, decisions: result.decisions };
    },

    "delivery.take": (p) => {
      const s = store(p.project);
      const items = s.takeDeliveries(p.sessionId, now());
      const text = formatDelivery(items, s.list());
      if (text) s.logDelivery(p.sessionId, items.length, text.length, now());
      return { text, delivered: items.length };
    },

    "stats.get": (p) => {
      const s = store(p.project);
      return computeStats({
        runs: s.runs(),
        deliveries: s.deliveryLog(),
        sessions: s.sessionCount(),
        decisions: s.list(),
      });
    },

    "agent.list": (p) => store(p.project).runs(p.target),

    "agent.cancel": (p) => {
      const entry = running.get(p.runId);
      if (!entry || entry.project !== canonicalPath(p.project)) {
        throw new StoreError("NotFound", `no running agent ${p.runId}`);
      }
      entry.controller.abort();
      return { ok: true as const };
    },

    "decision.answer": (p) => {
      const d = store(p.project).answer(p.id, p.expectedVersion, p.answer, p.rationale, now());
      flush(p.project);
      return d;
    },

    "decision.transition": (p) => {
      const d = store(p.project).transition(p.id, p.expectedVersion, p.to, p.reason, now());
      flush(p.project);
      return d;
    },

    "decision.hold": (p) => {
      const d = store(p.project).hold(p.id, p.expectedVersion, p.held, now());
      flush(p.project);
      return d;
    },

    "decision.fallback": (p) => {
      store(p.project).cancelBatch(p.batchId, FALLBACK_REASON, now());
      flush(p.project);
      return { ok: true as const };
    },

    "events.subscribe": (p, socket) => {
      subscribers.set(socket, p.project);
      return { ok: true as const };
    },
  };

  function handleRequest(socket: Socket, line: string): void {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      reply(socket, null, undefined, { code: ErrorCode.ParseError, message: "parse error" });
      return;
    }
    const id = typeof req.id === "number" ? req.id : null;
    const spec = methods[req.method as MethodName];
    if (!spec || id === null) {
      reply(socket, id, undefined, {
        code: ErrorCode.MethodNotFound,
        message: `unknown method ${req.method}`,
      });
      return;
    }
    const parsed = spec.params.safeParse(req.params ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reply(socket, id, undefined, {
        code: ErrorCode.InvalidParams,
        message: `${issue?.path.join(".") || "params"}: ${issue?.message}`,
      });
      return;
    }
    try {
      const handler = handlers[req.method as MethodName] as Handler<MethodName>;
      const result = handler(parsed.data as never, socket, (later) => reply(socket, id, later));
      if (result !== LATER) reply(socket, id, result);
    } catch (error) {
      reply(socket, id, undefined, toRpcError(error));
    }
  }

  let closing = false;

  /** The hook waiting on this batch is gone: withdraw its questions (ADR-0004 #5). */
  function abandon(w: Waiter): void {
    waiters.delete(w);
    const cancelled = store(w.project).cancelBatch(w.batchId, DISCONNECT_REASON, now());
    log(`batch ${w.batchId}: hook disconnected, cancelled ${cancelled.length}`);
    flush(w.project);
  }

  function onDisconnect(socket: Socket): void {
    sockets.delete(socket);
    const wasViewer = subscribers.delete(socket);
    if (closing) return; // shutdown already handled the waiters
    for (const w of [...waiters]) if (w.socket === socket) abandon(w);
    if (!wasViewer) return;
    // The last UI for a project closed while a hook was waiting: hand the batch back.
    for (const w of [...waiters]) {
      if (!w.requireViewer || hasViewer(w.project)) continue;
      store(w.project).cancelBatch(w.batchId, NO_VIEWER_REASON, now());
      log(`batch ${w.batchId}: no UI left, handed back to Claude Code`);
      flush(w.project); // settles the waiter with "fallback"
    }
  }

  await prepareSocketPath(options.socketPath);
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    const decoder = new LineDecoder();
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) handleRequest(socket, line);
    });
    socket.on("close", () => onDisconnect(socket));
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(options.socketPath, () => res());
  });
  chmodSync(options.socketPath, 0o600); // NFR-07: only the owner can connect
  log(`listening on ${options.socketPath}`);

  return {
    socketPath: options.socketPath,
    close: async () => {
      // Order matters: settle waiting hooks while the databases are still open, then drop
      // connections, then close the databases.
      closing = true;
      popups.close();
      for (const w of [...waiters]) abandon(w);
      // Stop agents and let them record "cancelled" before the databases close.
      for (const r of running.values()) r.controller.abort();
      await Promise.all([...running.values()].map((r) => r.done));
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
      for (const s of stores.values()) s.close();
      if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
    },
  };
}

/** Returned by a handler that will reply later (askBatch long poll). */
const LATER = Symbol("later");
/** Params after schema parsing, i.e. with defaults applied. */
type ParsedParams<M extends MethodName> = ReturnType<(typeof methods)[M]["params"]["parse"]>;

function reply(
  socket: Socket,
  id: number | null,
  result: unknown,
  error?: { code: number; message: string },
): void {
  if (socket.destroyed) return;
  socket.write(encode(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
}

function toRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof RpcFailure) return { code: error.code, message: error.message };
  if (error instanceof StoreError) {
    return {
      code:
        error.code === "Conflict"
          ? ErrorCode.Conflict
          : error.code === "InvalidDependency"
            ? ErrorCode.InvalidDependency
            : ErrorCode.NotFound,
      message: error.message,
    };
  }
  if (error instanceof DomainError) {
    return {
      code: error.code === "InvalidAnswer" ? ErrorCode.InvalidAnswer : ErrorCode.InvalidTransition,
      message: error.message,
    };
  }
  return { code: ErrorCode.Internal, message: "internal error" };
}

/** Create the socket directory (0700) and clear a stale socket; refuse if a daemon is alive. */
async function prepareSocketPath(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) return;
  const alive = await new Promise<boolean>((res) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      res(true);
    });
    probe.once("error", () => res(false));
  });
  if (alive) throw new Error(`a daemon is already listening on ${path}`);
  unlinkSync(path);
}
