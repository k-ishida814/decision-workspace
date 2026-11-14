#!/usr/bin/env bun
/**
 * Stand-in for `claude -p --output-format stream-json` in tests. Behaviour is chosen by
 * FAKE_MODE; FAKE_COUNTER (a file) counts invocations so retries can be scripted.
 *   ok | invalid | invalid-then-ok | missing | error | crash | hang
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "ok";
const counterFile = process.env.FAKE_COUNTER;
let call = 1;
if (counterFile) {
  call = (existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0) + 1;
  writeFileSync(counterFile, String(call));
}
if (process.env.FAKE_ARGS_FILE)
  writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));

const emit = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);
const result = (extra: Record<string, unknown>) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
    ...extra,
  });

emit({ type: "system", subtype: "init" });
emit({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", name: "Read" },
      { type: "tool_use", name: "WebSearch" },
    ],
  },
});

const good = process.env.FAKE_OUTPUT
  ? JSON.parse(process.env.FAKE_OUTPUT)
  : { answer: "ok", score: 3 };
if (process.env.FAKE_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_DELAY_MS));
switch (mode) {
  case "ok":
    result({ structured_output: good });
    break;
  case "invalid":
    result({ structured_output: { answer: 1 } });
    break;
  case "invalid-then-ok":
    result({ structured_output: call === 1 ? { answer: 1 } : good });
    break;
  case "missing":
    result({});
    break;
  case "error":
    result({ subtype: "error_max_budget_usd", is_error: true });
    break;
  case "crash":
    process.stderr.write("boom: not logged in\n");
    process.exit(3);
    break;
  case "hang":
    await new Promise(() => {});
}
