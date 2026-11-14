#!/usr/bin/env bun
/** Development entry point; the released binary runs the same code as `dw hook`. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { hookMain } from "./entry";

const cli = join(import.meta.dir, "../../cli/src/main.ts");
await hookMain((socketPath) =>
  spawn(process.execPath, [cli, "daemon", "run", "--socket", socketPath], {
    detached: true,
    stdio: "ignore",
  }).unref(),
);
