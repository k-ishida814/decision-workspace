import {
  answerText,
  type Command,
  closedList,
  conditionText,
  currentDecision,
  dependentsOf,
  historyRows,
  initialUiState,
  openList,
  overviewRows,
  proposalKindLabel,
  queueRows,
  runningReview,
  runningRun,
  selectedDecision,
  treePrefixes,
  type UiAction,
  type UiState,
  uiReducer,
} from "@dw/core";
import type { AgentRun, Decision, Exploration, Plan, Proposal, Revision } from "@dw/protocol";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { type Dispatch, useEffect, useReducer, useRef, useState } from "react";
import { type Backend, describeError } from "./backend";

const DIM = TextAttributes.DIM;
const BOLD = TextAttributes.BOLD;
const ACCENT = "#00D7FF";
const NOTICE = "#FFCC00";

export function App({ backend, title }: { backend: Backend; title?: string }) {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  const renderer = useRenderer();

  // Keep the decision list in sync with the daemon (DQ-09).
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      backend.list().then(
        (decisions) => alive && dispatch({ type: "sync", decisions }),
        (error) => alive && dispatch({ type: "failed", message: describeError(error) }),
      );
    const refreshProposals = () =>
      backend.proposals().then(
        (proposals) => alive && dispatch({ type: "proposals", proposals }),
        () => {},
      );
    const refreshRuns = () => {
      void refreshProposals(); // a finished review brings proposals
      return backend.runs().then(
        (runs) => alive && dispatch({ type: "runs", runs }),
        () => {},
      );
    };
    const unsubscribe = backend.subscribe(refresh);
    const unsubscribeRuns = backend.subscribeRuns(refreshRuns);
    void refresh();
    void refreshRuns();
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeRuns();
    };
  }, [backend]);

  // Run commands queued by the reducer.
  const running = useRef(false);
  useEffect(() => {
    if (state.outbox.length === 0 || running.current) return;
    const commands: Command[] = state.outbox;
    dispatch({ type: "drained" });
    running.current = true;
    void (async () => {
      for (const c of commands) {
        try {
          await backend.execute(c);
          if (c.type === "resolveProposal") {
            const proposals = await backend.proposals();
            dispatch({ type: "proposals", proposals });
          }
        } catch (error) {
          dispatch({
            type: "failed",
            id: "id" in c ? c.id : undefined,
            message: describeError(error),
          });
          backend.list().then((decisions) => dispatch({ type: "sync", decisions }));
          backend.proposals().then((proposals) => dispatch({ type: "proposals", proposals }));
        }
      }
      running.current = false;
    })();
  }, [state.outbox, backend]);

  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(() => dispatch({ type: "clearNotice" }), 4000);
    return () => clearTimeout(timer);
  }, [state.notice]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return renderer.destroy();
    if (state.editing) {
      if (key.name === "escape") dispatch({ type: "edit", mode: undefined });
      return; // other keys go to <input>
    }
    if (state.help) {
      if (key.sequence === "?" || key.name === "escape") dispatch({ type: "help" });
      return;
    }
    const action = keyToAction(key.name, key.sequence);
    if (action === "quit") return renderer.destroy();
    if (action) dispatch(action);
  });

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <Header state={state} title={title} />
      {state.editing === "plan" ? (
        <box border borderStyle="rounded" title=" Plan " padding={1} flexDirection="column">
          <text>What do you want to build or change? The Planner lists the decisions to make.</text>
          <TextInput
            placeholder="Describe it and press Enter (Esc to go back)"
            onSubmit={(value) => dispatch({ type: "submitText", value })}
          />
        </box>
      ) : null}
      {state.help ? (
        <Help />
      ) : state.view === "current" ? (
        <Current state={state} dispatch={dispatch} backend={backend} />
      ) : state.view === "queue" ? (
        <Queue state={state} />
      ) : state.view === "graph" ? (
        <Graph state={state} backend={backend} />
      ) : (
        <History state={state} backend={backend} />
      )}
      <Footer state={state} />
    </box>
  );
}

export function keyToAction(name: string, sequence: string): UiAction | "quit" | undefined {
  if (/^[1-9]$/.test(sequence)) return { type: "number", n: Number(sequence) };
  if (sequence === "?") return { type: "help" };
  switch (name) {
    case "q":
      return "quit";
    case "tab":
      return { type: "view" };
    case "j":
    case "down":
      return { type: "move", delta: 1 };
    case "k":
    case "up":
      return { type: "move", delta: -1 };
    case "space":
      return { type: "toggle" };
    case "return":
      return { type: "confirm" };
    case "o":
      return { type: "edit", mode: "answer" };
    case "w":
      return { type: "edit", mode: "why" };
    case "s":
      return { type: "skip" };
    case "h":
      return { type: "hold" };
    case "t":
      return { type: "fallback" };
    case "u":
      return { type: "revisit" };
    case "d":
      return { type: "explore" };
    case "p":
      return { type: "edit", mode: "plan" };
    case "r":
      return { type: "review" };
    case "a":
      return { type: "resolve", accept: true };
    case "x":
      return { type: "resolve", accept: false };
  }
  return undefined;
}

function Header({ state, title }: { state: UiState; title?: string }) {
  const tab = (label: string, active: boolean) => (active ? `[${label}]` : ` ${label} `);
  const open = openList(state);
  const held = open.filter((d) => d.held).length;
  const cost = state.runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  return (
    <box flexDirection="column">
      <text>
        <b>Decision Workspace</b> {tab("Current", state.view === "current")}
        {tab("Queue", state.view === "queue")}
        {tab("History", state.view === "history")}
        {tab("Graph", state.view === "graph")}{" "}
        <span fg="#888888">
          open {open.length - held}
          {held > 0 ? ` / held ${held}` : ""}
          {state.runs.length > 0 ? ` · agents ${state.runs.length} runs $${cost.toFixed(3)}` : ""}
          {title ? `  ${title}` : ""}
        </span>
      </text>
      {state.notice ? <text fg={NOTICE}>● {state.notice}</text> : null}
    </box>
  );
}

function batchPosition(state: UiState, d: Decision): string {
  if (!d.batchId) return "";
  const size = state.decisions.filter((x) => x.batchId === d.batchId).length;
  return size > 1 ? ` ${(d.batchIndex ?? 0) + 1}/${size}` : "";
}

function Current({
  state,
  dispatch,
  backend,
}: {
  state: UiState;
  dispatch: Dispatch<UiAction>;
  backend: Backend;
}) {
  const d = currentDecision(state);
  const exploration = useLatestExploration(backend, d);
  const run = d ? runningRun(state, d.id) : undefined;
  if (!d) {
    return (
      <box border borderStyle="rounded" padding={1}>
        <text attributes={DIM}>No open questions. Waiting for Claude Code…</text>
      </box>
    );
  }
  const title = ` ${d.id}${d.title ? ` · ${d.title}` : ""}${batchPosition(state, d)}${d.held ? " · held" : ""} `;
  return (
    <box border borderStyle="rounded" title={title} padding={1} flexDirection="column" gap={1}>
      <text attributes={BOLD} flexShrink={0}>
        {d.question}
      </text>
      {d.dependsOn.length > 0 ? (
        <text attributes={DIM}>
          After:{" "}
          {d.dependsOn
            .map((dep) => prerequisiteText(dep.id, dep.whenOptions, state.decisions))
            .join("、")}
        </text>
      ) : null}
      {d.status === "revisit" && d.answer ? (
        <text fg={NOTICE}>Answer again (was: {answerText(d)})</text>
      ) : null}
      {d.kind === "text" ? (
        <text attributes={DIM}>Free-text question. Press Enter to answer.</text>
      ) : (
        <box flexDirection="column" flexShrink={0}>
          {d.options.map((o, i) => {
            const active = i === state.cursor;
            const mark = d.kind === "multi" ? (state.picked.includes(o.id) ? "[x] " : "[ ] ") : "";
            return (
              // flexShrink 0: when a long Deep Dive overflows the screen, never squeeze the
              // option label away (it would vanish while its pros and cons stay).
              <box key={o.id} flexDirection="column" flexShrink={0}>
                <text
                  fg={active ? ACCENT : undefined}
                  attributes={active ? BOLD : 0}
                  flexShrink={0}
                >
                  {active ? "› " : "  "}
                  {mark}
                  {i + 1}. {o.label}
                  {o.recommended ? " ★ recommended" : ""}
                  {o.source === "explorer" ? " (from Deep Dive)" : ""}
                </text>
                {o.description ? (
                  <text attributes={DIM} flexShrink={0}>{`       ${o.description}`}</text>
                ) : null}
                <Tradeoff exploration={exploration} optionId={o.id} />
              </box>
            );
          })}
        </box>
      )}
      <DeepDive decision={d} exploration={exploration} run={run} />
      {d.kind === "multi" ? (
        <text attributes={DIM}>Multiple choice: digits / Space to toggle, Enter to confirm</text>
      ) : null}
      {state.rationale ? <text attributes={DIM}>Why: {state.rationale}</text> : null}
      {state.editing === "answer" || state.editing === "why" ? (
        <TextInput
          placeholder={
            state.editing === "why"
              ? "Why you decided (Enter to save, Esc to go back)"
              : "Your answer (Enter to send, Esc to go back)"
          }
          onSubmit={(value) => dispatch({ type: "submitText", value })}
        />
      ) : null}
    </box>
  );
}

/** Latest Deep Dive of the shown decision; refetched when the decision changes. */
function useLatestExploration(backend: Backend, d: Decision | undefined): Exploration | undefined {
  const [latest, setLatest] = useState<{ id: string; exploration?: Exploration }>();
  const id = d?.id;
  const version = d?.version;
  useEffect(() => {
    // version: a finished Deep Dive bumps it, so the new result is fetched.
    if (!id || version === undefined) return;
    let alive = true;
    backend.explorations(id).then(
      (list) => {
        if (alive) setLatest({ id, exploration: list.at(-1) });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [backend, id, version]);
  return latest && latest.id === id ? latest.exploration : undefined;
}

function Tradeoff({ exploration, optionId }: { exploration?: Exploration; optionId: string }) {
  const t = exploration?.tradeoffs.find((x) => x.optionId === optionId);
  if (!t || (t.pros.length === 0 && t.cons.length === 0)) return null;
  // The top two of each: the full list is in `dw show`.
  return (
    <box flexDirection="column" flexShrink={0}>
      {t.pros.length > 0 ? (
        <text fg="#4ADE80">{`       + ${t.pros.slice(0, 2).join(" / ")}`}</text>
      ) : null}
      {t.cons.length > 0 ? (
        <text fg="#F87171">{`       - ${t.cons.slice(0, 2).join(" / ")}`}</text>
      ) : null}
    </box>
  );
}

/** Seconds since an ISO time, re-rendering every second while shown. */
function useElapsed(since: string | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
}

const minutes = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** Hook timeout installed by `dw install` (design §5.3). */
const HOOK_TIMEOUT_SEC = 600;

function DeepDive({
  decision,
  exploration,
  run,
}: {
  decision: Decision;
  exploration?: Exploration;
  run?: AgentRun;
}) {
  const running = useElapsed(run?.startedAt);
  const waiting = useElapsed(run && decision.origin === "ask" ? decision.createdAt : undefined);
  const recommended = decision.options.find((o) => o.recommended && o.reason);
  return (
    <box flexDirection="column" flexShrink={0}>
      {exploration ? <text flexShrink={0}>Deep Dive: {exploration.summary}</text> : null}
      {recommended ? (
        <text fg={ACCENT} flexShrink={0}>
          Recommended: {recommended.label} — {recommended.reason}
        </text>
      ) : null}
      {run ? (
        <text fg={NOTICE}>
          Deep Dive running… ({minutes(running)}, {run.model}) d to cancel
        </text>
      ) : null}
      {run && decision.origin === "ask" ? (
        <text fg={waiting > HOOK_TIMEOUT_SEC - 120 ? "#FF6B6B" : NOTICE}>
          Claude Code is waiting ({minutes(waiting)} so far; it gives up after{" "}
          {HOOK_TIMEOUT_SEC / 60} minutes)
        </text>
      ) : null}
    </box>
  );
}

/**
 * OpenTUI 0.8.4 types `onSubmit` as `((e: SubmitEvent) => void) & ((value: string) => void)`,
 * so keep the value from onInput and submit with no argument (ADR-0002).
 */
function TextInput({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (value: string) => void;
}) {
  const draft = useRef("");
  return (
    <input
      focused
      placeholder={placeholder}
      onInput={(v: string) => {
        draft.current = v;
      }}
      onSubmit={() => onSubmit(draft.current)}
    />
  );
}

function prerequisiteText(
  id: string,
  when: readonly string[] | undefined,
  all: readonly Decision[],
): string {
  const parent = all.find((d) => d.id === id);
  if (!parent) return id;
  const value = parent.status === "decided" ? answerText(parent) : "undecided";
  const condition = when
    ? ` (when ${when.map((o) => parent.options.find((x) => x.id === o)?.label ?? o).join(" / ")})`
    : "";
  return `${id} ${parent.title || parent.question} = ${value}${condition}`;
}

function Queue({ state }: { state: UiState }) {
  const rows = queueRows(state);
  if (rows.length === 0) return <text attributes={DIM}>No open questions</text>;
  const index = Math.min(state.listIndex, rows.length - 1);
  return (
    <box border borderStyle="rounded" title=" Queue " padding={1} flexDirection="column">
      {rows.map((row, i) => {
        const d = row.decision;
        const active = i === index;
        const waiting = row.waitingOn.length > 0;
        return (
          <box key={d.id} flexDirection="column">
            {row.planHeader ? <text attributes={BOLD}>{row.planHeader}</text> : null}
            <text fg={active ? ACCENT : undefined} attributes={active ? BOLD : waiting ? DIM : 0}>
              {active ? "› " : "  "}
              {"  ".repeat(row.depth)}
              {row.depth > 0 ? "└ " : ""}
              {d.id.padEnd(5)} {d.held ? "held " : d.status === "revisit" ? "re-check " : ""}
              {d.title ? `[${d.title}] ` : ""}
              {d.question}
              {waiting ? `  (waiting for ${row.waitingOn.join(", ")})` : ""}
            </text>
          </box>
        );
      })}
    </box>
  );
}

function History({ state, backend }: { state: UiState; backend: Backend }) {
  const items = closedList(state);
  const rows = historyRows(state);
  const index = Math.min(state.listIndex, rows.length - 1);
  const review = runningReview(state);
  const current = selectedDecision(state);
  const [revisions, setRevisions] = useState<{ id: string; list: Revision[] }>();
  const currentId = current?.id;
  const currentRevision = current?.revision ?? 0;
  useEffect(() => {
    if (!currentId || currentRevision < 2) return;
    let alive = true;
    backend.revisions(currentId).then(
      (list) => {
        if (alive) setRevisions({ id: currentId, list });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [backend, currentId, currentRevision]);

  const offset = state.proposals.length;
  return (
    <box flexDirection="column" gap={1}>
      {review ? <text fg={NOTICE}>Reviewer running… ({review.model}) r to cancel</text> : null}
      {state.proposals.length > 0 ? (
        <Proposals proposals={state.proposals} index={index} all={state.decisions} />
      ) : null}
      {items.length === 0 ? (
        <text attributes={DIM}>Nothing decided yet</text>
      ) : (
        <box border borderStyle="rounded" title=" History " padding={1} flexDirection="column">
          {items.map((d, i) => {
            const active = i + offset === index;
            return (
              <box key={d.id} flexDirection="column">
                <text fg={active ? ACCENT : undefined} attributes={active ? BOLD : 0}>
                  {active ? "› " : "  "}
                  {d.id.padEnd(5)} {statusLabel(d).padEnd(10)}
                  {d.title ? `[${d.title}] ` : ""}
                  {d.question}
                </text>
                {d.answer ? (
                  <text attributes={DIM}>
                    {`         → ${answerText(d)}${d.rationale ? ` (why: ${d.rationale})` : ""}${d.revision > 1 ? ` · revision ${d.revision}` : ""}`}
                  </text>
                ) : null}
                {active ? (
                  <Diff
                    decision={d}
                    all={state.decisions}
                    revisions={revisions?.id === d.id ? revisions.list : undefined}
                  />
                ) : null}
              </box>
            );
          })}
        </box>
      )}
    </box>
  );
}

/** T-310: Reviewer proposals; a accepts, x dismisses the selected one. */
function Proposals({
  proposals,
  index,
  all,
}: {
  proposals: readonly Proposal[];
  index: number;
  all: readonly Decision[];
}) {
  const name = (id: string) => {
    const d = all.find((x) => x.id === id);
    return d ? `${id} ${d.title || d.question}` : id;
  };
  return (
    <box
      border
      borderStyle="rounded"
      title=" Reviewer proposals (a accept / x dismiss) "
      padding={1}
      flexDirection="column"
    >
      {proposals.map((p, i) => {
        const active = i === index;
        return (
          <box key={p.id} flexDirection="column">
            <text fg={active ? ACCENT : NOTICE} attributes={active ? BOLD : 0}>
              {active ? "› " : "  "}
              {p.id} [{proposalKindLabel(p.kind)}] {p.title}
            </text>
            <text attributes={DIM}>{`         ${p.reason}`}</text>
            {p.kind === "add" && p.draft ? (
              <text attributes={DIM}>
                {`         new decision: ${p.draft.question}${p.draft.options.length > 0 ? ` (${p.draft.options.map((o) => o.label).join(" / ")})` : ""}`}
              </text>
            ) : null}
            {p.decisionIds.length > 0 ? (
              <text attributes={DIM}>
                {`         ${p.kind === "add" ? "after" : "reopens"}: ${p.decisionIds.map(name).join(", ")}`}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

const STATUS_COLOR: Partial<Record<Decision["status"], string>> = {
  decided: "#4ADE80",
  ready: ACCENT,
  revisit: NOTICE,
};

/** T-314: every decision of every plan as a tree, with answers, conditions and closed branches. */
function Graph({ state, backend }: { state: UiState; backend: Backend }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const count = state.decisions.length;
  useEffect(() => {
    // Refetch when decisions are added (a new plan may have come with them).
    if (count < 0) return;
    let alive = true;
    backend.plans().then(
      (p) => {
        if (alive) setPlans(p);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [backend, count]);

  const rows = overviewRows(state.decisions);
  if (rows.length === 0) return <text attributes={DIM}>No decisions yet</text>;
  const prefixes = treePrefixes(rows);
  const index = Math.min(state.listIndex, rows.length - 1);
  return (
    <box border borderStyle="rounded" title=" Graph " padding={1} flexDirection="column">
      {rows.map((row, i) => {
        const d = row.decision;
        const active = i === index;
        const closed = d.status === "skipped" || d.status === "cancelled";
        const answer =
          d.status === "decided" || d.status === "revisit" ? ` → ${answerText(d)}` : "";
        const condition = row.via ? conditionText(row.via, state.decisions) : undefined;
        const notes = [
          condition ? `when ${condition}` : "",
          row.alsoAfter.length > 0 ? `also after ${row.alsoAfter.join(", ")}` : "",
          d.closedReason ? reasonLabel(d.closedReason) : "",
        ].filter(Boolean);
        const plan = plans.find((p) => p.id === row.planHeader);
        return (
          <box key={d.id} flexDirection="column">
            {row.planHeader !== undefined ? (
              <text attributes={BOLD}>
                {row.planHeader ? `${row.planHeader} ${plan?.request ?? ""}` : "(no plan)"}
              </text>
            ) : null}
            <text
              fg={active ? ACCENT : closed ? undefined : STATUS_COLOR[d.status]}
              attributes={active ? BOLD : closed || d.status === "pending" ? DIM : 0}
            >
              {active ? "›" : " "}
              {prefixes[i]} {d.id} [{statusLabel(d)}] {d.title || d.question}
              {answer}
              {notes.length > 0 ? `  (${notes.join("; ")})` : ""}
            </text>
          </box>
        );
      })}
    </box>
  );
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "condition-unmet":
      return "skipped: condition not met";
    case "prerequisite-closed":
      return "skipped: prerequisite closed";
    case "hook-disconnected":
      return "withdrawn by Claude Code";
    default:
      return reason;
  }
}

/** DG-05: previous answer and what depends on it, under the selected History row. */
function Diff({
  decision,
  all,
  revisions,
}: {
  decision: Decision;
  all: readonly Decision[];
  revisions?: Revision[];
}) {
  const affected = dependentsOf(decision.id, all);
  const previous = revisions?.at(-2);
  const label = (r: Revision) =>
    [
      r.answer.selected
        .map((id) => decision.options.find((o) => o.id === id)?.label ?? id)
        .join(", "),
      r.answer.text,
    ]
      .filter(Boolean)
      .join(" / ");
  if (!previous && affected.length === 0) return null;
  return (
    <box flexDirection="column">
      {previous ? (
        <text
          fg={NOTICE}
        >{`         was (revision ${previous.revision}): ${label(previous)}`}</text>
      ) : null}
      {affected.length > 0 ? (
        <text attributes={DIM}>
          {`         affects: ${affected.map((a) => `${a.id} ${statusLabel(a)}`).join(", ")}`}
        </text>
      ) : null}
    </box>
  );
}

function statusLabel(d: Decision): string {
  switch (d.status) {
    case "decided":
      return "decided";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "pending":
      return "waiting";
    case "ready":
      return "open";
    case "revisit":
      return "re-check";
    default:
      return d.status;
  }
}

const KEYS: [string, string][] = [
  ["j / k, ↑ / ↓", "move"],
  ["1-9", "choose an option (toggle in multiple choice)"],
  ["Space", "toggle in multiple choice"],
  ["Enter", "confirm (Queue / Graph: open the selected one)"],
  ["o", "answer in your own words"],
  ["w", "write why (goes with the next answer)"],
  ["s", "skip"],
  ["h", "put aside / bring back"],
  ["t", "answer in Claude Code's own UI instead"],
  ["u", "History / Graph: change a decided answer"],
  ["p", "Planner: list the decisions for a request (calls the model)"],
  ["r", "Reviewer: check the decided answers (calls the model) / cancel it"],
  ["a / x", "History: accept / dismiss a Reviewer proposal"],
  ["d", "Deep Dive: an agent researches the options (calls the model) / cancel it"],
  ["Tab", "switch Current / Queue / History / Graph"],
  ["?", "help"],
  ["q / Ctrl+C", "quit"],
];

function Help() {
  return (
    <box border borderStyle="rounded" title=" Keys " padding={1} flexDirection="column">
      {KEYS.map(([k, d]) => (
        <text key={k}>
          <b>{k.padEnd(14)}</b> {d}
        </text>
      ))}
    </box>
  );
}

function Footer({ state }: { state: UiState }) {
  const hint = state.editing
    ? "Enter confirm · Esc back"
    : state.view === "current"
      ? "digits choose · Enter confirm · o own words · w why · d deep dive · s skip · h hold · t Claude UI · Tab views · ? help"
      : state.view === "queue"
        ? "j/k move · Enter open · h hold · s skip · Tab views · ? help"
        : state.view === "graph"
          ? "j/k move · Enter open · d deep dive · u change · s skip · Tab views · ? help"
          : "j/k move · u change · r review · a accept · x dismiss · Tab views · ? help";
  return <text attributes={DIM}>{hint}</text>;
}
