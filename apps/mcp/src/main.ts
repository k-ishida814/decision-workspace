#!/usr/bin/env bun
/** Development entry point; the released binary runs the same code as `dw mcp`. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mcpMain } from "./entry";

const cli = join(import.meta.dir, "../../cli/src/main.ts");
await mcpMain((socketPath) =>
  spawn(process.execPath, [cli, "daemon", "run", "--socket", socketPath], {
    detached: true,
    stdio: "ignore",
  }).unref(),
);
