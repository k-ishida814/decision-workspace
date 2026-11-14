import { z } from "zod";

/** Decision lifecycle states (requirements DQ-03). */
export const DecisionStatus = z.enum([
  "pending",
  "exploring",
  "ready",
  "decided",
  "revisit",
  "skipped",
  "cancelled",
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/**
 * How the user answers (DQ-02).
 * - single: pick one option
 * - multi:  pick one or more options
 * - text:   free text only (no options)
 * Free text alongside options is controlled by `allowOther`.
 */
export const InputKind = z.enum(["single", "multi", "text"]);
export type InputKind = z.infer<typeof InputKind>;

export const Option = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  reason: z.string().optional(),
  /** Who proposed it. Missing = the creator of the decision. */
  source: z.enum(["claude", "explorer", "user"]).optional(),
});
export type Option = z.infer<typeof Option>;

/**
 * Where a decision came from.
 * - ask:    Claude Code's AskUserQuestion; a hook is waiting for the answer
 * - plan:   the Planner or Claude via MCP; nobody is waiting
 * - manual: added by the user (CLI / TUI)
 */
export const Origin = z.enum(["ask", "plan", "manual"]);
export type Origin = z.infer<typeof Origin>;

/**
 * A prerequisite. The decision only applies once `id` is decided, and — when `whenOptions` is
 * set — only if that answer selected at least one of those option ids (design D3).
 */
export const Dependency = z.object({
  id: z.string().regex(/^D-\d+$/),
  whenOptions: z.array(z.string()).min(1).optional(),
});
export type Dependency = z.infer<typeof Dependency>;

/** An answer: chosen option ids and/or free text. */
export const Answer = z
  .object({
    selected: z.array(z.string()).default([]),
    text: z.string().optional(),
  })
  .refine((a) => a.selected.length > 0 || (a.text?.trim().length ?? 0) > 0, {
    message: "answer needs at least one selected option or non-empty text",
  });
export type Answer = z.infer<typeof Answer>;

export const DecisionId = z.string().regex(/^D-\d+$/);

export const Decision = z.object({
  id: DecisionId,
  origin: Origin,
  /** Plan ("P-n") this decision belongs to, if any. */
  planId: z.string().optional(),
  dependsOn: z.array(Dependency),
  /** Groups decisions created from one AskUserQuestion call (= tool_use_id). */
  batchId: z.string().optional(),
  batchIndex: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  title: z.string(),
  question: z.string().min(1),
  kind: InputKind,
  allowOther: z.boolean(),
  options: z.array(Option),
  status: DecisionStatus,
  /** Put aside by the user; sorted after the others (DQ-06). */
  held: z.boolean(),
  /** Optimistic-lock version; bumped on every change (DQ-07). */
  version: z.number().int().positive(),
  /** Number of answers recorded so far (DQ-05). 0 = never answered. */
  revision: z.number().int().nonnegative(),
  answer: Answer.optional(),
  rationale: z.string().optional(),
  /** Why the decision was skipped / cancelled, if it was. */
  closedReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Decision = z.infer<typeof Decision>;

/** One recorded answer. Never deleted, even when the decision is answered again (DQ-05). */
export const Revision = z.object({
  decisionId: DecisionId,
  revision: z.number().int().positive(),
  answer: Answer,
  rationale: z.string().optional(),
  createdAt: z.string(),
});
export type Revision = z.infer<typeof Revision>;

/**
 * A prerequisite while creating. `ref` is an existing id ("D-3") or the `key` of another decision
 * created in the same call, so a plan can wire its own decisions together.
 */
export const NewDependency = z.object({
  ref: z.string().min(1),
  whenOptions: z.array(z.string()).min(1).optional(),
});
export type NewDependency = z.infer<typeof NewDependency>;

export const NewDecision = z.object({
  /** Local name for `NewDependency.ref` within one create call. Not stored. */
  key: z.string().min(1).optional(),
  origin: Origin.default("manual"),
  planId: z.string().optional(),
  dependsOn: z.array(NewDependency).default([]),
  batchId: z.string().optional(),
  batchIndex: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  title: z.string().default(""),
  question: z.string().min(1),
  kind: InputKind,
  allowOther: z.boolean().default(true),
  options: z.array(Option).default([]),
});
export type NewDecision = z.input<typeof NewDecision>;

// --- Phase 3 records ----------------------------------------------------------------------------

export const PlanId = z.string().regex(/^P-\d+$/);

export const Plan = z.object({
  id: PlanId,
  request: z.string(),
  source: z.enum(["user", "claude"]),
  sessionId: z.string().optional(),
  status: z.enum(["planning", "ready", "failed"]),
  createdAt: z.string(),
});
export type Plan = z.infer<typeof Plan>;

export const AgentKind = z.enum(["planner", "explorer", "reviewer"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** One `claude -p` run (AG-05). The transcript stays on disk, never in the parent context. */
export const AgentRun = z.object({
  id: z.string(),
  kind: AgentKind,
  /** Decision id, plan id, or "project" for a project-wide review. */
  target: z.string(),
  model: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  transcriptPath: z.string().optional(),
  error: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRun>;

/** Result of a Deep Dive, kept as history (design §5.3). */
export const Exploration = z.object({
  decisionId: DecisionId,
  runId: z.string(),
  summary: z.string(),
  tradeoffs: z.array(
    z.object({ optionId: z.string(), pros: z.array(z.string()), cons: z.array(z.string()) }),
  ),
  createdAt: z.string(),
});
export type Exploration = z.infer<typeof Exploration>;

/** What a Reviewer proposal asks for (T-310, AG-03). */
export const ProposalKind = z.enum(["conflict", "revisit", "add"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

/**
 * A Reviewer suggestion. Nothing changes until the user accepts it: conflict / revisit reopen the
 * decided decisions in `decisionIds`; add creates a new decision that depends on them.
 */
export const Proposal = z.object({
  id: z.string().regex(/^RV-\d+$/),
  runId: z.string(),
  /** Plan id, or "project" for a project-wide review. */
  target: z.string(),
  kind: ProposalKind,
  title: z.string(),
  reason: z.string(),
  decisionIds: z.array(DecisionId),
  /** Only for kind "add": the decision to create. */
  draft: z
    .object({
      question: z.string().min(1),
      multiSelect: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    })
    .optional(),
  /** superseded: a newer review of the same target replaced it before it was resolved. */
  status: z.enum(["open", "accepted", "dismissed", "superseded"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
export type Proposal = z.infer<typeof Proposal>;

/** One context block handed to Claude (T-313). */
export const DeliveryLogEntry = z.object({
  sessionId: z.string(),
  items: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
  at: z.string(),
});
export type DeliveryLogEntry = z.infer<typeof DeliveryLogEntry>;

const AgentTotals = z.object({
  runs: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  running: z.number().int(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  durationMs: z.number().int(),
});

/** `dw stats` (T-313, NFR-10). */
export const Stats = z.object({
  agents: z.object({ total: AgentTotals, byKind: z.record(AgentKind, AgentTotals) }),
  context: z.object({
    /** Claude Code sessions whose prompt hook has run. */
    sessions: z.number().int(),
    /** Prompts that got a context block. */
    blocks: z.number().int(),
    decisions: z.number().int(),
    chars: z.number().int(),
    maxChars: z.number().int(),
  }),
  decisions: z.object({
    total: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    byOrigin: z.record(z.string(), z.number().int()),
    /** Answers given, including re-answers (revisions). */
    answers: z.number().int(),
    /** Decisions answered more than once. */
    changed: z.number().int(),
  }),
});
export type Stats = z.infer<typeof Stats>;
