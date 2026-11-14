#!/usr/bin/env bun
/**
 * Minimal MCP server (stdio) used only by the e2e test as `--permission-prompt-tool`.
 *
 * `claude -p` offers AskUserQuestion only when a permission host exists (headless docs). Our
 * PreToolUse hook answers first, so this host should never be asked about AskUserQuestion; it
 * denies everything and appends each request to $DW_E2E_PERMISSION_LOG so the test can check.
 */
import { appendFileSync } from "node:fs";

const log = process.env.DW_E2E_PERMISSION_LOG;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (msg.id === undefined) continue; // notifications
    switch (msg.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "dw-e2e-permission", version: "0.0.0" },
          },
        });
        break;
      case "tools/list":
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              {
                name: "deny",
                description: "e2e permission host: denies every request",
                inputSchema: {
                  type: "object",
                  properties: { tool_name: { type: "string" }, input: { type: "object" } },
                },
              },
            ],
          },
        });
        break;
      case "tools/call": {
        const args = (msg.params?.arguments ?? {}) as { tool_name?: string };
        if (log) appendFileSync(log, `${args.tool_name ?? "?"}\n`);
        const decision = { behavior: "deny", message: "e2e: no human is available" };
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(decision) }] },
        });
        break;
      }
      default:
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `unknown method ${msg.method}` },
        });
    }
  }
});
