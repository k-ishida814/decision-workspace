#!/usr/bin/env bun
/**
 * Stands in for the Tauri Popup in tests (T-602). Reads the `show` message, records it, and
 * behaves as FAKE_POPUP says:
 *   answer (default) first option of every question · skip · fallback · toWorkspace
 *   noshow (never says shown) · crash (exits after shown) · hang (shown, then waits) · garbage
 * FAKE_POPUP_LOG: append {pid, show} as one JSON line per run.
 */
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_POPUP ?? "answer";
const reader = Bun.stdin.stream().getReader();
let buffered = "";
while (!buffered.includes("\n")) {
  const { value, done } = await reader.read();
  if (done) break;
  buffered += new TextDecoder().decode(value);
}
const show = JSON.parse(buffered.split("\n")[0] ?? "{}");
if (process.env.FAKE_POPUP_LOG) {
  appendFileSync(process.env.FAKE_POPUP_LOG, `${JSON.stringify({ pid: process.pid, show })}\n`);
}
const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);

if (mode === "noshow") await Bun.sleep(60_000);
out({ type: "shown" });
const delay = Number(process.env.FAKE_POPUP_DELAY_MS ?? 0);
if (delay) await Bun.sleep(delay);
switch (mode) {
  case "answer":
    out({
      type: "answer",
      answers: show.questions.map((q: { id: string; options: { id: string }[] }) =>
        q.options.length > 0
          ? { id: q.id, selected: [q.options[0]?.id] }
          : { id: q.id, selected: [], text: "typed" },
      ),
    });
    break;
  case "skip":
    out({
      type: "answer",
      answers: show.questions.map((q: { id: string }) => ({ id: q.id, skipped: true })),
    });
    break;
  case "fallback":
  case "toWorkspace":
    out({ type: mode });
    break;
  case "crash":
    process.exit(3);
    break;
  case "garbage":
    process.stdout.write("not json\n");
    out({ type: "answer", answers: [] }); // invalid: no answers
    break;
  case "hang":
    await Bun.sleep(60_000);
    break;
}
process.exit(0);
