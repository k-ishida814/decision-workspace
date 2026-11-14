/**
 * `dw install` / `dw uninstall` (T-205, CC-06): add or remove our PreToolUse hook in a project's
 * Claude Code settings without touching anything else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Hook commands written before the single binary (development installs); still recognised. */
export const HOOK_ENTRY = "apps/hook/src/main.ts";
export const STATUS_MESSAGE = "Waiting for your answer in Decision Workspace (dw tui)";

type HookHandler = { type: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookHandler[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[] | undefined>; [k: string]: unknown };

/**
 * Ours: `"<dw>" hook` (released binary, or `"<bun>" ".../cli/src/main.ts" hook` in development),
 * or the older direct hook entry. Uninstall never touches anyone else's hooks.
 */
const isOurs = (h: HookHandler) =>
  typeof h.command === "string" &&
  (h.command.includes(HOOK_ENTRY) || /(\/dw|\/cli\/src\/main\.ts)" hook$/.test(h.command));

const quote = (arg: string) => `"${arg}"`;

/** @param self how to run dw (see self.ts) */
export function hookCommand(self: readonly string[]): string {
  return `${self.map(quote).join(" ")} hook`;
}

/** Returns new settings with exactly our hooks (replacing older ones). */
export function withHook(settings: Settings, command: string, timeoutSec: number): Settings {
  const cleaned = withoutHook(settings);
  const ask: HookGroup = {
    matcher: "AskUserQuestion",
    hooks: [{ type: "command", command, timeout: timeoutSec, statusMessage: STATUS_MESSAGE }],
  };
  // T-312: tell Claude about decisions made since the last message. Short timeout: it runs
  // before every prompt.
  const prompt: HookGroup = { hooks: [{ type: "command", command, timeout: 10 }] };
  return {
    ...cleaned,
    hooks: {
      ...cleaned.hooks,
      PreToolUse: [...(cleaned.hooks?.PreToolUse ?? []), ask],
      UserPromptSubmit: [...(cleaned.hooks?.UserPromptSubmit ?? []), prompt],
    },
  };
}

/** Returns new settings without our hook; drops containers that become empty. */
/** Returns new settings without our hooks (any event); drops containers that become empty. */
export function withoutHook(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[] | undefined> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function hasHook(settings: Settings): boolean {
  return Object.values(settings.hooks ?? {}).some((groups) =>
    (groups ?? []).some((g) => (g.hooks ?? []).some(isOurs)),
  );
}

export function settingsPath(project: string, local: boolean): string {
  return join(project, ".claude", local ? "settings.local.json" : "settings.json");
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Settings;
}

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

// --- MCP server (T-311) -------------------------------------------------------------------------

export const MCP_NAME = "decision-workspace";

type McpJson = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

export function mcpJsonPath(project: string): string {
  return join(project, ".mcp.json");
}

export function withMcp(json: McpJson, self: readonly string[]): McpJson {
  const [command, ...args] = self;
  return {
    ...json,
    mcpServers: {
      ...json.mcpServers,
      [MCP_NAME]: { type: "stdio", command, args: [...args, "mcp"] },
    },
  };
}

export function withoutMcp(json: McpJson): McpJson {
  if (!json.mcpServers || !(MCP_NAME in json.mcpServers)) return json;
  const { [MCP_NAME]: _ours, ...rest } = json.mcpServers;
  const next: McpJson = { ...json, mcpServers: rest };
  if (Object.keys(rest).length === 0) delete next.mcpServers;
  return next;
}

export function hasMcp(json: McpJson): boolean {
  return Boolean(json.mcpServers && MCP_NAME in json.mcpServers);
}

/** Pre-approve our project MCP server so Claude Code does not ask on first use. */
export function withMcpApproved(settings: Settings): Settings {
  const list = Array.isArray(settings.enabledMcpjsonServers)
    ? (settings.enabledMcpjsonServers as string[])
    : [];
  return list.includes(MCP_NAME)
    ? settings
    : { ...settings, enabledMcpjsonServers: [...list, MCP_NAME] };
}

export function withoutMcpApproved(settings: Settings): Settings {
  if (!Array.isArray(settings.enabledMcpjsonServers)) return settings;
  const list = (settings.enabledMcpjsonServers as string[]).filter((n) => n !== MCP_NAME);
  const next: Settings = { ...settings, enabledMcpjsonServers: list };
  if (list.length === 0) delete next.enabledMcpjsonServers;
  return next;
}
