/** The real MCP entry point over stdio, as Claude Code starts it (T-311). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@dw/daemon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let dir: string;
let daemon: Daemon;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-mcp-io-"));
  daemon = await startDaemon({ socketPath: join(dir, "d.sock") });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

test("bun apps/mcp/src/main.ts serves the tools for the project in CLAUDE_PROJECT_DIR", async () => {
  const project = join(dir, "p");
  mkdirSync(join(project, ".git"), { recursive: true });
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "../../apps/mcp/src/main.ts")],
    env: {
      ...(process.env as Record<string, string>),
      DW_SOCKET: join(dir, "d.sock"),
      CLAUDE_PROJECT_DIR: project,
    },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    expect((await client.listTools()).tools).toHaveLength(3);
    const r = await client.callTool({
      name: "decision_ask",
      arguments: { title: "t", decisions: [{ key: "a", question: "A?" }] },
    });
    expect((r.content as { text: string }[])[0]?.text).toContain("a = D-1 [ready]");
  } finally {
    await client.close();
  }
});
