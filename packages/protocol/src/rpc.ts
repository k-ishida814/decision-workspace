/**
 * JSON-RPC 2.0 methods between clients (CLI / TUI / hook / MCP / VS Code) and the daemon
 * (ADR-0004). Framing: one JSON object per line over a Unix domain socket.
 */
import { z } from "zod";
import {
  AgentRun,
  Answer,
  Decision,
  DecisionStatus,
  Exploration,
  NewDecision,
  Plan,
  Proposal,
  Revision,
  Stats,
} from "./decision";

/** Absolute path of the project root. Each project has its own database (DQ-08). */
const Project = z.string().min(1);
const Version = z.number().int().positive();

/** A question as Claude Code's AskUserQuestion sends it. */
export const AskQuestion = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
    .default([]),
});
export type AskQuestion = z.input<typeof AskQuestion>;

export const AskBatchResult = z.discriminatedUnion("status", [
  /** Answers keyed by question text, in AskUserQuestion's `answers` format. */
  z.object({ status: z.literal("answered"), answers: z.record(z.string(), z.string()) }),
  /** The user chose to answer in Claude Code's own UI. */
  z.object({ status: z.literal("fallback") }),
  /** The user cancelled a decision in the batch. (Skipped ones are answered with a note.) */
  z.object({ status: z.literal("cancelled") }),
]);
export type AskBatchResult = z.infer<typeof AskBatchResult>;

export const methods = {
  "daemon.ping": {
    params: z.object({}).default({}),
    result: z.object({ pid: z.number(), version: z.string() }),
  },
  "decision.create": {
    params: z.object({ project: Project, decisions: z.array(NewDecision).min(1) }),
    result: z.array(Decision),
  },
  /**
   * Register an AskUserQuestion call and wait (long poll) until every question is answered.
   * If the connection drops first, the daemon cancels the batch (ADR-0004 #5).
   */
  "decision.askBatch": {
    params: z.object({
      project: Project,
      batchId: z.string().min(1),
      sessionId: z.string().optional(),
      questions: z.array(AskQuestion).min(1),
      /**
       * Hand the batch back right away (status "fallback") when no UI is watching the project,
       * and when the last one closes while waiting. The hook sets this so a question nobody can
       * see doesn't block Claude Code until its timeout.
       */
      requireViewer: z.boolean().default(false),
    }),
    result: AskBatchResult,
  },
  "decision.list": {
    params: z.object({ project: Project, status: z.array(DecisionStatus).optional() }),
    result: z.array(Decision),
  },
  "decision.get": {
    params: z.object({ project: Project, id: z.string() }),
    result: z.object({
      decision: Decision,
      revisions: z.array(Revision),
      /** Deep Dive results, oldest first (design §5.3). */
      explorations: z.array(Exploration).default([]),
    }),
  },
  "decision.answer": {
    params: z.object({
      project: Project,
      id: z.string(),
      expectedVersion: Version,
      answer: Answer,
      rationale: z.string().optional(),
    }),
    result: Decision,
  },
  /** skip / cancel / revisit etc. Any change the transition table allows. */
  "decision.transition": {
    params: z.object({
      project: Project,
      id: z.string(),
      expectedVersion: Version,
      to: DecisionStatus,
      reason: z.string().optional(),
    }),
    result: Decision,
  },
  "decision.hold": {
    params: z.object({
      project: Project,
      id: z.string(),
      expectedVersion: Version,
      held: z.boolean(),
    }),
    result: Decision,
  },
  /** Give a whole AskUserQuestion batch back to Claude Code's own UI. */
  "decision.fallback": {
    params: z.object({ project: Project, batchId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Start a Deep Dive on one decision (T-308, P2). Returns at once; progress arrives as `run`
   * notifications and the result as a `decision.updated` event.
   */
  "decision.explore": {
    params: z.object({ project: Project, id: z.string() }),
    result: AgentRun,
  },
  /**
   * Register a plan and its decisions in one call (T-311 decision_ask, T-309 Planner). Decisions
   * may reference each other by `key` and get origin "plan" and the new plan id.
   */
  "plan.create": {
    params: z.object({
      project: Project,
      request: z.string().min(1),
      source: z.enum(["user", "claude"]),
      sessionId: z.string().optional(),
      decisions: z.array(NewDecision).min(1).max(50),
    }),
    result: z.object({ plan: Plan, decisions: z.array(Decision) }),
  },
  /** T-309: run the Planner on a request. Returns at once; the decisions arrive as events. */
  "plan.generate": {
    params: z.object({ project: Project, request: z.string().min(1).max(4000) }),
    result: z.object({ plan: Plan, run: AgentRun }),
  },
  "plan.list": {
    params: z.object({ project: Project }),
    result: z.array(Plan),
  },
  /**
   * Context for Claude's next prompt (T-312): decisions this session has not been told about,
   * marked as delivered. `text` is absent when there is nothing new.
   */
  "delivery.take": {
    params: z.object({ project: Project, sessionId: z.string().min(1) }),
    result: z.object({ text: z.string().optional(), delivered: z.number().int().nonnegative() }),
  },
  /**
   * T-310: run the Reviewer over the decided decisions of a plan (or the whole project). Returns
   * at once; proposals are listed with review.list once the run finishes.
   */
  "review.start": {
    params: z.object({
      project: Project,
      planId: z
        .string()
        .regex(/^P-\d+$/)
        .optional(),
    }),
    result: AgentRun,
  },
  "review.list": {
    params: z.object({
      project: Project,
      status: z.array(Proposal.shape.status).optional(),
    }),
    result: z.array(Proposal),
  },
  /** Accept (apply) or dismiss one proposal. `decisions` are the decisions it changed or created. */
  "review.resolve": {
    params: z.object({ project: Project, id: z.string(), accept: z.boolean() }),
    result: z.object({ proposal: Proposal, decisions: z.array(Decision) }),
  },
  /** T-313 (NFR-10): agent runs, cost, tokens, context handed to Claude, decisions. */
  "stats.get": {
    params: z.object({ project: Project }),
    result: Stats,
  },
  /** Agent runs of a project, optionally for one target (decision / plan id). */
  "agent.list": {
    params: z.object({ project: Project, target: z.string().optional() }),
    result: z.array(AgentRun),
  },
  "agent.cancel": {
    params: z.object({ project: Project, runId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Start receiving `event` notifications. Omit project to receive all projects. */
  "events.subscribe": {
    params: z.object({ project: Project.optional() }).default({}),
    result: z.object({ ok: z.literal(true) }),
  },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = z.input<Methods[M]["params"]>;
export type ResultOf<M extends MethodName> = z.infer<Methods[M]["result"]>;

/** Pushed from the daemon to subscribers (DQ-09). */
export const DwEvent = z.object({
  type: z.enum(["decision.created", "decision.updated"]),
  project: Project,
  decision: Decision,
});
export type DwEvent = z.infer<typeof DwEvent>;

/** Pushed to subscribers when an agent run starts or finishes (method "run"). */
export const RunEvent = z.object({ project: Project, run: AgentRun });
export type RunEvent = z.infer<typeof RunEvent>;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** expectedVersion did not match: someone else changed it first (NFR-02). */
  Conflict: -32001,
  NotFound: -32002,
  InvalidTransition: -32003,
  InvalidAnswer: -32004,
  /** Unknown, self-referencing or cyclic dependency (DG-02). */
  InvalidDependency: -32005,
  /** A Deep Dive is already running for that decision, or agents are unavailable. */
  AgentBusy: -32006,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type RpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type RpcError = { code: number; message: string; data?: unknown };
export type RpcResponse =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number | null; error: RpcError };
