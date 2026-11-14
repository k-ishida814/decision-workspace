import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  answerDecision,
  createDecision,
  DomainError,
  type ExplorationResult,
  findCycle,
  formatId,
  gate,
  holdDecision,
  initialStatus,
  mergeExploration,
  type ProposalDraft,
  propagate,
  transitionDecision,
} from "@dw/core";
import type {
  AgentRun,
  Answer,
  Decision,
  DecisionStatus,
  DeliveryLogEntry,
  Exploration,
  NewDecision,
  Plan,
  Proposal,
  Revision,
} from "@dw/protocol";
import init001 from "./migrations/001_init.sql" with { type: "text" };

/**
 * Applied in order; PRAGMA user_version records how many have run (ADR-0003). Add new files for
 * schema changes; never edit a released one.
 */
const MIGRATIONS: readonly string[] = [init001];

export type StoreErrorCode = "Conflict" | "NotFound" | "InvalidDependency";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Where a project's decisions live (ADR-0003). */
export function dbPathFor(projectRoot: string): string {
  return join(projectRoot, ".decision-workspace", "decisions.db");
}

type Row = {
  id: string;
  origin: Decision["origin"];
  plan_id: string | null;
  batch_id: string | null;
  batch_index: number | null;
  session_id: string | null;
  title: string;
  question: string;
  kind: Decision["kind"];
  allow_other: number;
  options_json: string;
  status: DecisionStatus;
  held: number;
  version: number;
  revision: number;
  answer_json: string | null;
  rationale: string | null;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
};

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

type DepRow = { decision_id: string; depends_on: string; when_options_json: string | null };

function fromRow(r: Row, deps: readonly DepRow[]): Decision {
  return {
    id: r.id,
    origin: r.origin,
    planId: opt(r.plan_id),
    dependsOn: deps.map((d) =>
      d.when_options_json
        ? { id: d.depends_on, whenOptions: JSON.parse(d.when_options_json) as string[] }
        : { id: d.depends_on },
    ),
    batchId: opt(r.batch_id),
    batchIndex: opt(r.batch_index),
    sessionId: opt(r.session_id),
    title: r.title,
    question: r.question,
    kind: r.kind,
    allowOther: r.allow_other === 1,
    options: JSON.parse(r.options_json),
    status: r.status,
    held: r.held === 1,
    version: r.version,
    revision: r.revision,
    answer: r.answer_json ? JSON.parse(r.answer_json) : undefined,
    rationale: opt(r.rationale),
    closedReason: opt(r.closed_reason),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function params(d: Decision) {
  return {
    $id: d.id,
    $origin: d.origin,
    $plan_id: d.planId ?? null,
    $batch_id: d.batchId ?? null,
    $batch_index: d.batchIndex ?? null,
    $session_id: d.sessionId ?? null,
    $title: d.title,
    $question: d.question,
    $kind: d.kind,
    $allow_other: d.allowOther ? 1 : 0,
    $options_json: JSON.stringify(d.options),
    $status: d.status,
    $held: d.held ? 1 : 0,
    $version: d.version,
    $revision: d.revision,
    $answer_json: d.answer ? JSON.stringify(d.answer) : null,
    $rationale: d.rationale ?? null,
    $closed_reason: d.closedReason ?? null,
    $created_at: d.createdAt,
    $updated_at: d.updatedAt,
  };
}

export type Delivery = { decision: Decision; previous?: Revision };

export class Store {
  readonly db: Database;
  /** Decisions changed since the last takeChanges(), committed only (see tx). */
  private outbox: Decision[] = [];
  private staged: Decision[] = [];
  private depth = 0;

  /** Pass ":memory:" for tests. Creates parent directories for file paths. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = (this.db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i] as string);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      })();
    }
    // Development builds before 0.1.0 numbered their migrations differently; such a database
    // can claim to be up to date without the full schema. Refuse it instead of corrupting it.
    const complete = this.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'delivery_log'")
      .get();
    if (!complete) {
      this.db.close();
      throw new Error(
        "this decisions.db was made by a development build of dw before 0.1.0; move the project's .decision-workspace/ folder away and try again",
      );
    }
  }

  // --- reads ---------------------------------------------------------------------------------

  get(id: string): Decision | undefined {
    const row = this.db.query("SELECT * FROM decisions WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrate([row])[0] : undefined;
  }

  /** Attach dependencies to rows (one query for the whole set). */
  private hydrate(rows: readonly Row[]): Decision[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const deps = this.db
      .query(
        `SELECT * FROM dependencies WHERE decision_id IN (${ids.map(() => "?").join(",")})
         ORDER BY rowid`,
      )
      .all(...ids) as DepRow[];
    const byId = new Map<string, DepRow[]>();
    for (const d of deps) byId.set(d.decision_id, [...(byId.get(d.decision_id) ?? []), d]);
    return rows.map((r) => fromRow(r, byId.get(r.id) ?? []));
  }

  list(status?: readonly DecisionStatus[]): Decision[] {
    const rows =
      status && status.length > 0
        ? (this.db
            .query(
              `SELECT * FROM decisions WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY seq`,
            )
            .all(...status) as Row[])
        : (this.db.query("SELECT * FROM decisions ORDER BY seq").all() as Row[]);
    return this.hydrate(rows);
  }

  byBatch(batchId: string): Decision[] {
    const rows = this.db
      .query("SELECT * FROM decisions WHERE batch_id = ? ORDER BY batch_index, seq")
      .all(batchId) as Row[];
    return this.hydrate(rows);
  }

  revisions(id: string): Revision[] {
    const rows = this.db
      .query("SELECT * FROM revisions WHERE decision_id = ? ORDER BY revision")
      .all(id) as {
      decision_id: string;
      revision: number;
      answer_json: string;
      rationale: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      decisionId: r.decision_id,
      revision: r.revision,
      answer: JSON.parse(r.answer_json) as Answer,
      rationale: opt(r.rationale),
      createdAt: r.created_at,
    }));
  }

  // --- writes --------------------------------------------------------------------------------

  /**
   * Every decision changed by committed writes since the last call, including ones the graph
   * moved (DG-03). The daemon publishes these as events.
   */
  takeChanges(): Decision[] {
    const latest = new Map<string, Decision>();
    for (const d of this.outbox) latest.set(d.id, d);
    this.outbox = [];
    return [...latest.values()];
  }

  /** Transaction that only publishes staged changes if the outermost one commits. */
  tx<T>(fn: () => T): T {
    this.depth++;
    try {
      const result = this.db.transaction(fn)();
      if (this.depth === 1) this.outbox.push(...this.staged);
      return result;
    } finally {
      if (this.depth === 1) this.staged = [];
      this.depth--;
    }
  }

  private byIdMap(): Map<string, Decision> {
    return new Map(this.list().map((d) => [d.id, d]));
  }

  create(inputs: readonly NewDecision[], now: string): Decision[] {
    return this.tx(() => {
      const { next } = this.db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM decisions")
        .get() as { next: number };
      // Keys name decisions inside this call so they can depend on each other.
      const keys = new Map<string, string>();
      inputs.forEach((input, i) => {
        if (!input.key) return;
        if (keys.has(input.key))
          throw new StoreError("InvalidDependency", `duplicate key "${input.key}"`);
        keys.set(input.key, formatId(next + i));
      });
      const existing = this.byIdMap();
      const resolve = (ref: string): string => {
        const id = keys.get(ref) ?? ref;
        if (!keys.has(ref) && !existing.has(id)) {
          throw new StoreError("InvalidDependency", `unknown dependency "${ref}"`);
        }
        return id;
      };
      let created = inputs.map((input, i) => {
        const id = formatId(next + i);
        const deps = (input.dependsOn ?? []).map((d) => ({ ...d, ref: resolve(d.ref) }));
        if (deps.some((d) => d.ref === id)) {
          throw new StoreError("InvalidDependency", `${id} cannot depend on itself`);
        }
        return createDecision({ ...input, dependsOn: deps }, id, now);
      });
      const cycle = findCycle([...existing.values(), ...created]);
      if (cycle)
        throw new StoreError("InvalidDependency", `dependency cycle: ${cycle.join(" → ")}`);

      // Start each new decision in the status its prerequisites allow (DG-06). Repeat until
      // stable so decisions created together see each other's starting status.
      for (let pass = 0; pass < created.length; pass++) {
        const all = new Map([...existing, ...created.map((d) => [d.id, d] as const)]);
        const settled = created.map((d) => ({ ...d, ...initialStatus(d, all) }));
        const changed = settled.some((d, i) => d.status !== created[i]?.status);
        created = settled;
        if (!changed) break;
      }

      created.forEach((d, i) => {
        this.db
          .query(
            `INSERT INTO decisions (seq, id, origin, plan_id, batch_id, batch_index, session_id,
               title, question, kind, allow_other, options_json, status, held, version, revision,
               answer_json, rationale, closed_reason, created_at, updated_at)
             VALUES ($seq, $id, $origin, $plan_id, $batch_id, $batch_index, $session_id,
               $title, $question, $kind, $allow_other, $options_json, $status, $held, $version,
               $revision, $answer_json, $rationale, $closed_reason, $created_at, $updated_at)`,
          )
          .run({ $seq: next + i, ...params(d) });
        for (const dep of d.dependsOn) {
          this.db
            .query(
              "INSERT INTO dependencies (decision_id, depends_on, when_options_json) VALUES (?, ?, ?)",
            )
            .run(d.id, dep.id, dep.whenOptions ? JSON.stringify(dep.whenOptions) : null);
        }
        this.event(d.id, "created", undefined, d.status, d.closedReason, now);
      });
      return created;
    });
  }

  answer(
    id: string,
    expectedVersion: number,
    answer: Answer,
    rationale: string | undefined,
    now: string,
  ): Decision {
    return this.mutate(id, expectedVersion, "answered", now, (d) => {
      const waitingOn = d.dependsOn.find((dep) => this.get(dep.id)?.status !== "decided");
      if (gate(d, this.byIdMap()) !== "open") {
        throw new DomainError(
          "InvalidTransition",
          `${d.id} cannot be answered until its prerequisite ${waitingOn?.id ?? ""} is decided`,
        );
      }
      const result = answerDecision(d, answer, rationale, now);
      this.db
        .query(
          `INSERT INTO revisions (decision_id, revision, answer_json, rationale, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          result.revision.revision,
          JSON.stringify(result.revision.answer),
          rationale ?? null,
          now,
        );
      return result.decision;
    });
  }

  transition(
    id: string,
    expectedVersion: number,
    to: DecisionStatus,
    reason: string | undefined,
    now: string,
  ): Decision {
    return this.mutate(id, expectedVersion, "transition", now, (d) => {
      const next = transitionDecision(d, to, reason, now);
      // Reopening a skipped decision: ready right away if its prerequisites allow it.
      if (to === "pending" && initialStatus(next, this.byIdMap()).status === "ready") {
        return { ...next, status: "ready" };
      }
      return next;
    });
  }

  hold(id: string, expectedVersion: number, held: boolean, now: string): Decision {
    return this.mutate(id, expectedVersion, held ? "held" : "unheld", now, (d) =>
      holdDecision(d, held, now),
    );
  }

  /**
   * Cancel every open decision of a batch, regardless of version. System action used for
   * fallback and when the waiting hook disconnects (ADR-0004 #5).
   */
  cancelBatch(batchId: string, reason: string, now: string): Decision[] {
    return this.tx(() =>
      this.byBatch(batchId)
        .filter((d) => d.status !== "decided" && d.status !== "cancelled" && d.status !== "skipped")
        .map((d) =>
          this.mutate(d.id, d.version, "transition", now, (x) =>
            transitionDecision(x, "cancelled", reason, now),
          ),
        ),
    );
  }

  /**
   * Load, check version, apply, write back guarded by the same version (NFR-02), then let the
   * graph update everything downstream in the same transaction (DG-03, DG-04).
   */
  private mutate(
    id: string,
    expectedVersion: number,
    type: string,
    now: string,
    apply: (d: Decision) => Decision,
  ): Decision {
    return this.tx(() => {
      const current = this.get(id);
      if (!current) throw new StoreError("NotFound", `decision ${id} not found`);
      if (current.version !== expectedVersion) {
        throw new StoreError(
          "Conflict",
          `decision ${id} was changed by someone else (version ${current.version}, expected ${expectedVersion})`,
        );
      }
      const next = apply(current);
      this.write(next, expectedVersion);
      this.event(id, type, current.status, next.status, next.closedReason, now);
      this.staged.push(next);
      if (next.status !== current.status) {
        for (const moved of propagate(next, this.list(), now)) {
          const before = this.get(moved.id) as Decision;
          this.write(moved, before.version);
          this.event(moved.id, "graph", before.status, moved.status, moved.closedReason, now);
          this.staged.push(moved);
        }
      }
      return next;
    });
  }

  private write(d: Decision, expectedVersion: number): void {
    const result = this.db
      .query(
        `UPDATE decisions SET status = $status, held = $held, version = $version,
           revision = $revision, answer_json = $answer_json, rationale = $rationale,
           closed_reason = $closed_reason, updated_at = $updated_at
         WHERE id = $id AND version = $expected`,
      )
      .run({ ...params(d), $expected: expectedVersion });
    if (result.changes !== 1)
      throw new StoreError("Conflict", `decision ${d.id} was changed concurrently`);
  }

  // --- deliveries to Claude (T-312, CC-09) ---------------------------------------------------

  /**
   * Decisions this Claude Code session has not been told about yet, marked as delivered.
   * The first call for a session only records a baseline (returns nothing), so a new session is
   * not flooded with the project's history. An AskUserQuestion answer already reached Claude in
   * place, so it is delivered only when it is changed later (revision ≥ 2).
   */
  takeDeliveries(sessionId: string, now: string): Delivery[] {
    return this.db.transaction(() => {
      const seen = this.db.query("SELECT 1 FROM sessions_seen WHERE session_id = ?").get(sessionId);
      const decided = this.list(["decided"]);
      const mark = this.db.query(
        "INSERT OR IGNORE INTO deliveries (session_id, decision_id, revision, delivered_at) VALUES (?, ?, ?, ?)",
      );
      if (!seen) {
        this.db
          .query("INSERT INTO sessions_seen (session_id, first_seen_at) VALUES (?, ?)")
          .run(sessionId, now);
        for (const d of decided) mark.run(sessionId, d.id, d.revision, now);
        return [];
      }
      const delivered = this.db.query(
        "SELECT 1 FROM deliveries WHERE session_id = ? AND decision_id = ? AND revision = ?",
      );
      const out: Delivery[] = [];
      for (const d of decided) {
        if (d.origin === "ask" && d.revision < 2) continue;
        if (delivered.get(sessionId, d.id, d.revision)) continue;
        mark.run(sessionId, d.id, d.revision, now);
        const previous =
          d.revision > 1
            ? this.revisions(d.id).find((r) => r.revision === d.revision - 1)
            : undefined;
        out.push({ decision: d, previous });
      }
      return out;
    })();
  }

  /** T-313: remember the size of a context block handed to Claude. */
  logDelivery(sessionId: string, items: number, chars: number, now: string): void {
    this.db
      .query("INSERT INTO delivery_log (session_id, items, chars, at) VALUES (?, ?, ?, ?)")
      .run(sessionId, items, chars, now);
  }

  deliveryLog(): DeliveryLogEntry[] {
    const rows = this.db.query("SELECT * FROM delivery_log ORDER BY rowid").all() as {
      session_id: string;
      items: number;
      chars: number;
      at: string;
    }[];
    return rows.map((r) => ({ sessionId: r.session_id, items: r.items, chars: r.chars, at: r.at }));
  }

  sessionCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM sessions_seen").get() as { n: number }).n;
  }

  // --- plans ---------------------------------------------------------------------------------

  createPlan(input: Pick<Plan, "request" | "source" | "sessionId" | "status">, now: string): Plan {
    return this.db.transaction(() => {
      const { next } = this.db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM plans")
        .get() as {
        next: number;
      };
      const plan: Plan = { id: `P-${next}`, ...input, createdAt: now };
      this.db
        .query(
          "INSERT INTO plans (seq, id, request, source, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(next, plan.id, plan.request, plan.source, plan.sessionId ?? null, plan.status, now);
      return plan;
    })();
  }

  setPlanStatus(id: string, status: Plan["status"]): void {
    this.db.query("UPDATE plans SET status = ? WHERE id = ?").run(status, id);
  }

  plans(): Plan[] {
    const rows = this.db.query("SELECT * FROM plans ORDER BY seq").all() as Record<
      string,
      string | null
    >[];
    return rows.map((r) => ({
      id: r.id as string,
      request: r.request as string,
      source: r.source as Plan["source"],
      sessionId: opt(r.session_id),
      status: r.status as Plan["status"],
      createdAt: r.created_at as string,
    }));
  }

  // --- Deep Dive (T-308) -----------------------------------------------------------------------

  /**
   * Keep the result as history and merge it into the decision (recommendation, new options).
   * A decision closed meanwhile only gets the history entry.
   */
  applyExploration(
    decisionId: string,
    runId: string,
    result: ExplorationResult,
    now: string,
  ): Decision {
    return this.tx(() => {
      const current = this.get(decisionId);
      if (!current) throw new StoreError("NotFound", `decision ${decisionId} not found`);
      this.db
        .query(
          "INSERT INTO explorations (decision_id, run_id, summary, tradeoffs_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(decisionId, runId, result.summary, JSON.stringify(result.tradeoffs), now);
      const merged = mergeExploration(current, result, now);
      if (merged === current) return current;
      this.db
        .query(
          `UPDATE decisions SET options_json = $options_json, kind = $kind, allow_other = $allow_other,
             version = $version, updated_at = $updated_at
           WHERE id = $id AND version = $expected`,
        )
        .run({
          $options_json: JSON.stringify(merged.options),
          $kind: merged.kind,
          $allow_other: merged.allowOther ? 1 : 0,
          $version: merged.version,
          $updated_at: merged.updatedAt,
          $id: merged.id,
          $expected: current.version,
        });
      this.event(decisionId, "explored", current.status, merged.status, undefined, now);
      this.staged.push(merged);
      return merged;
    });
  }

  explorations(decisionId: string): Exploration[] {
    const rows = this.db
      .query("SELECT * FROM explorations WHERE decision_id = ? ORDER BY rowid")
      .all(decisionId) as {
      decision_id: string;
      run_id: string;
      summary: string;
      tradeoffs_json: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      decisionId: r.decision_id,
      runId: r.run_id,
      summary: r.summary,
      tradeoffs: JSON.parse(r.tradeoffs_json),
      createdAt: r.created_at,
    }));
  }

  // --- Reviewer proposals (T-310) ------------------------------------------------------------

  /** Store a review's proposals; open ones from an earlier review of the same target are superseded. */
  addProposals(
    runId: string,
    target: string,
    drafts: readonly ProposalDraft[],
    now: string,
  ): Proposal[] {
    return this.db.transaction(() => {
      this.db
        .query(
          "UPDATE proposals SET status = 'superseded', resolved_at = ? WHERE target = ? AND status = 'open'",
        )
        .run(now, target);
      const insert = this.db.query(
        `INSERT INTO proposals (seq, id, run_id, target, kind, title, reason, decision_ids_json,
           draft_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      );
      const ids: string[] = [];
      for (const d of drafts) {
        const { next } = this.db
          .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM proposals")
          .get() as { next: number };
        const id = `RV-${next}`;
        insert.run(
          next,
          id,
          runId,
          target,
          d.kind,
          d.title,
          d.reason,
          JSON.stringify(d.decisionIds),
          d.draft ? JSON.stringify(d.draft) : null,
          now,
        );
        ids.push(id);
      }
      return this.proposals().filter((p) => ids.includes(p.id));
    })();
  }

  proposals(status?: readonly Proposal["status"][]): Proposal[] {
    const rows = this.db.query("SELECT * FROM proposals ORDER BY seq").all() as Record<
      string,
      string | null
    >[];
    return rows
      .map(
        (r): Proposal => ({
          id: r.id as string,
          runId: r.run_id as string,
          target: r.target as string,
          kind: r.kind as Proposal["kind"],
          title: r.title as string,
          reason: r.reason as string,
          decisionIds: JSON.parse(r.decision_ids_json as string),
          draft: r.draft_json ? JSON.parse(r.draft_json) : undefined,
          status: r.status as Proposal["status"],
          createdAt: r.created_at as string,
          resolvedAt: opt(r.resolved_at),
        }),
      )
      .filter((p) => !status || status.includes(p.status));
  }

  /** Mark an open proposal accepted or dismissed. Applying it is the caller's job (same tx). */
  resolveProposal(id: string, status: "accepted" | "dismissed", now: string): Proposal {
    const changed = this.db
      .query("UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
      .run(status, now, id);
    const proposal = this.proposals().find((p) => p.id === id);
    if (!proposal) throw new StoreError("NotFound", `proposal ${id} not found`);
    if (changed.changes !== 1) {
      throw new DomainError("InvalidTransition", `${id} is already ${proposal.status}`);
    }
    return proposal;
  }

  // --- agent runs (AG-05) ---------------------------------------------------------------------

  startRun(input: Pick<AgentRun, "kind" | "target" | "model">, now: string): AgentRun {
    return this.db.transaction(() => {
      const { n } = this.db.query("SELECT COUNT(*) + 1 AS n FROM agent_runs").get() as {
        n: number;
      };
      const run: AgentRun = { id: `R-${n}`, ...input, status: "running", startedAt: now };
      this.db
        .query(
          "INSERT INTO agent_runs (id, kind, target, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(run.id, run.kind, run.target, run.model, run.status, run.startedAt);
      return run;
    })();
  }

  finishRun(
    id: string,
    result: Pick<AgentRun, "status"> &
      Partial<
        Pick<
          AgentRun,
          "durationMs" | "costUsd" | "inputTokens" | "outputTokens" | "transcriptPath" | "error"
        >
      >,
  ): AgentRun {
    const changed = this.db
      .query(
        `UPDATE agent_runs SET status = ?, duration_ms = ?, cost_usd = ?, input_tokens = ?,
           output_tokens = ?, transcript_path = ?, error = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        result.status,
        result.durationMs ?? null,
        result.costUsd ?? null,
        result.inputTokens ?? null,
        result.outputTokens ?? null,
        result.transcriptPath ?? null,
        result.error ?? null,
        id,
      );
    if (changed.changes !== 1) throw new StoreError("NotFound", `no running agent run ${id}`);
    return this.runs().find((r) => r.id === id) as AgentRun;
  }

  runs(target?: string): AgentRun[] {
    const rows = (
      target
        ? this.db.query("SELECT * FROM agent_runs WHERE target = ? ORDER BY rowid").all(target)
        : this.db.query("SELECT * FROM agent_runs ORDER BY rowid").all()
    ) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as AgentRun["kind"],
      target: r.target as string,
      model: r.model as string,
      status: r.status as AgentRun["status"],
      startedAt: r.started_at as string,
      durationMs: opt(r.duration_ms as number | null),
      costUsd: opt(r.cost_usd as number | null),
      inputTokens: opt(r.input_tokens as number | null),
      outputTokens: opt(r.output_tokens as number | null),
      transcriptPath: opt(r.transcript_path as string | null),
      error: opt(r.error as string | null),
    }));
  }

  /** Runs left "running" by a daemon that stopped (crash, restart). Called when a store opens. */
  abandonRunningRuns(reason: string): number {
    return this.db
      .query("UPDATE agent_runs SET status = 'failed', error = ? WHERE status = 'running'")
      .run(reason).changes;
  }

  private event(
    decisionId: string,
    type: string,
    from: DecisionStatus | undefined,
    to: DecisionStatus | undefined,
    reason: string | undefined,
    at: string,
  ): void {
    this.db
      .query(
        "INSERT INTO events (decision_id, type, from_status, to_status, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(decisionId, type, from ?? null, to ?? null, reason ?? null, at);
  }
}
