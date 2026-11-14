/**
 * What Claude Code starts over stdio (`dw mcp`, registered by `dw install` in .mcp.json).
 * Starts the daemon if needed. Never prints to stdout except MCP frames.
 */
import { DwClient, defaultSocketPath, findProjectRoot } from "@dw/ipc-client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

/** Runs until Claude Code closes stdin or the daemon goes away. */
export async function mcpMain(startDaemon: (socketPath: string) => void): Promise<never> {
  const socketPath = defaultSocketPath();
  const client = await DwClient.connect({ socketPath, autoStart: () => startDaemon(socketPath) });
  const project = findProjectRoot(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  await createMcpServer(client, project).connect(new StdioServerTransport());
  client.onClose(() => process.exit(0));
  return new Promise<never>(() => {});
}
