/** User settings in ~/.decision-workspace/config.json (CF-01, design/phase3.md D7–D8). */
import { z } from "zod";

export const AgentConfig = z.object({
  /** `claude --model` value. */
  model: z.string().min(1).default("sonnet"),
  /** Per-run cap passed as --max-budget-usd (S-03: observed max $0.16). */
  maxBudgetUsd: z.number().positive().max(20).default(0.5),
  /** Per-run cap passed as --max-turns (S-03: observed 3–4). */
  maxTurns: z.number().int().min(1).max(100).default(12),
  /** How many agent runs the daemon allows at once. */
  concurrency: z.number().int().min(1).max(8).default(2),
});

export const Config = z.object({
  agents: AgentConfig.default(AgentConfig.parse({})),
});
export type Config = z.infer<typeof Config>;

export const DEFAULT_CONFIG: Config = Config.parse({});

/** Dotted keys that `dw config set` accepts, with how to read the raw string. */
export const CONFIG_KEYS = {
  "agents.model": "string",
  "agents.maxBudgetUsd": "number",
  "agents.maxTurns": "number",
  "agents.concurrency": "number",
} as const;
export type ConfigKey = keyof typeof CONFIG_KEYS;
