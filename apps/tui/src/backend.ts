/** What the TUI needs from the daemon. Tests pass a fake; the app uses `daemonBackend`. */
import type { Command } from "@dw/core";
import { type DwClient, RpcCallError } from "@dw/ipc-client";
import {
  type AgentRun,
  type Decision,
  ErrorCode,
  type Exploration,
  type Plan,
  type Proposal,
  type Revision,
} from "@dw/protocol";

export type Backend = {
  /** Every decision of the project. */
  list: () => Promise<Decision[]>;
  /** Called whenever something may have changed. Returns an unsubscribe function. */
  subscribe: (onChange: () => void) => () => void;
  execute: (command: Command) => Promise<void>;
  /** Answer history of one decision (History view, DG-05). */
  revisions: (id: string) => Promise<Revision[]>;
  /** Deep Dive results of one decision, oldest first. */
  explorations: (id: string) => Promise<Exploration[]>;
  /** Plans of the project (Graph view headers). */
  plans: () => Promise<Plan[]>;
  /** Open Reviewer proposals (T-310). */
  proposals: () => Promise<Proposal[]>;
  /** Agent runs of the project. */
  runs: () => Promise<AgentRun[]>;
  /** Called when an agent run starts or finishes. */
  subscribeRuns: (onChange: () => void) => () => void;
};

export function daemonBackend(client: DwClient, project: string): Backend {
  return {
    list: () => client.call("decision.list", { project }),
    revisions: async (id) => (await client.call("decision.get", { project, id })).revisions,
    explorations: async (id) => (await client.call("decision.get", { project, id })).explorations,
    runs: () => client.call("agent.list", { project }),
    plans: () => client.call("plan.list", { project }),
    proposals: () => client.call("review.list", { project, status: ["open"] }),
    subscribeRuns: (onChange) => client.onRun(() => onChange()),
    subscribe: (onChange) => {
      void client.call("events.subscribe", { project });
      return client.onEvent(() => onChange());
    },
    execute: async (c) => {
      switch (c.type) {
        case "answer":
          await client.call("decision.answer", {
            project,
            id: c.id,
            expectedVersion: c.expectedVersion,
            answer: c.answer,
            rationale: c.rationale,
          });
          return;
        case "transition":
          await client.call("decision.transition", {
            project,
            id: c.id,
            expectedVersion: c.expectedVersion,
            to: c.to,
            reason: c.reason,
          });
          return;
        case "hold":
          await client.call("decision.hold", {
            project,
            id: c.id,
            expectedVersion: c.expectedVersion,
            held: c.held,
          });
          return;
        case "fallback":
          await client.call("decision.fallback", { project, batchId: c.batchId });
          return;
        case "explore":
          await client.call("decision.explore", { project, id: c.id });
          return;
        case "plan":
          await client.call("plan.generate", { project, request: c.request });
          return;
        case "review":
          await client.call("review.start", { project });
          return;
        case "resolveProposal":
          await client.call("review.resolve", { project, id: c.id, accept: c.accept });
          return;
        case "cancelRun":
          await client.call("agent.cancel", { project, runId: c.runId });
          return;
      }
    },
  };
}

/** Human-readable message for a failed command. */
export function describeError(error: unknown): string {
  if (error instanceof RpcCallError && error.code === ErrorCode.Conflict) {
    return "Changed elsewhere first, so this was not applied (showing the latest state)";
  }
  return `Error: ${(error as Error).message}`;
}

export type { Decision };
