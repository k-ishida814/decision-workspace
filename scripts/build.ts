#!/usr/bin/env bun
/**
 * Release build: one self-contained `dw` binary (CLI, TUI, daemon, hook and MCP server).
 *
 *   bun scripts/build.ts                 # this machine → dist/dw
 *   bun scripts/build.ts --target bun-darwin-arm64 --version 0.1.0
 *
 * Build each platform on that platform: OpenTUI's native library is installed per platform.
 */
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    version: { type: "string" },
    outfile: { type: "string", default: "dist/dw" },
  },
});
const version = values.version ?? pkg.version;

const result = await Bun.build({
  entrypoints: ["apps/cli/src/main.ts"],
  compile: values.target
    ? { target: values.target as Bun.Build.CompileTarget, outfile: values.outfile }
    : { outfile: values.outfile },
  define: { DW_VERSION: JSON.stringify(version) },
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${values.outfile} (${version}${values.target ? `, ${values.target}` : ""})`);
