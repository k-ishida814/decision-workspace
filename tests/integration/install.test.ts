import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dw/cli";

let project: string;
const settingsFile = () => join(project, ".claude", "settings.json");
const read = (file = settingsFile()) => JSON.parse(readFileSync(file, "utf8"));

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "dw-install-"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

async function dw(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv, "--project", project], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const existing = {
  permissions: { allow: ["Bash(git log:*)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
  },
};

test("install adds one AskUserQuestion hook and keeps everything else (CC-06)", async () => {
  mkdirSync(join(project, ".claude"));
  writeFileSync(settingsFile(), JSON.stringify(existing));
  expect((await dw("install")).code).toBe(0);
  expect((await dw("install", "--timeout", "900")).code).toBe(0); // again: replaces, not duplicates

  const s = read();
  expect(s.permissions).toEqual(existing.permissions);
  expect(s.hooks.Stop).toEqual(existing.hooks.Stop);
  expect(s.hooks.PreToolUse).toHaveLength(2);
  expect(s.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
  const ours = s.hooks.PreToolUse[1];
  expect(ours.matcher).toBe("AskUserQuestion");
  expect(ours.hooks[0]).toMatchObject({ type: "command", timeout: 900 });
  // From source: bun + the CLI entry; the released binary writes `"<dw>" hook`.
  expect(ours.hooks[0].command).toMatch(/\/cli\/src\/main\.ts" hook$/);
  expect(ours.hooks[0].statusMessage).toContain("dw tui");
  // T-312: the same command also runs before every prompt, with a short timeout.
  expect(s.hooks.UserPromptSubmit).toHaveLength(1);
  expect(s.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ type: "command", timeout: 10 });
});

test("uninstall removes only our hook and restores the original shape", async () => {
  mkdirSync(join(project, ".claude"));
  writeFileSync(settingsFile(), JSON.stringify(existing));
  await dw("install");
  expect((await dw("uninstall")).out).toContain("removed");
  expect(read()).toEqual(existing);
  expect((await dw("uninstall")).out).toContain("not installed");
});

test("fresh project: creates the file; uninstall leaves an empty object", async () => {
  await dw("install");
  expect(read().hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
  await dw("uninstall");
  expect(read()).toEqual({});
});

test("--local writes settings.local.json only", async () => {
  await dw("install", "--local");
  expect(existsSync(settingsFile())).toBe(false);
  expect(read(join(project, ".claude", "settings.local.json")).hooks.PreToolUse).toHaveLength(1);
});

test("broken settings are not overwritten", async () => {
  mkdirSync(join(project, ".claude"));
  writeFileSync(settingsFile(), "{ not json");
  const r = await dw("install");
  expect(r.code).toBe(1);
  expect(readFileSync(settingsFile(), "utf8")).toBe("{ not json");
});

test("install registers the MCP server in .mcp.json and pre-approves it; uninstall removes only ours", async () => {
  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "other-server" } } }),
  );
  await dw("install");
  const mcp = read(join(project, ".mcp.json"));
  expect(mcp.mcpServers.other).toEqual({ command: "other-server" });
  expect(mcp.mcpServers["decision-workspace"].args[0]).toContain("apps/cli/src/main.ts");
  expect(mcp.mcpServers["decision-workspace"].args[1]).toBe("mcp");
  expect(read().enabledMcpjsonServers).toEqual(["decision-workspace"]);

  await dw("install"); // idempotent
  expect(read().enabledMcpjsonServers).toEqual(["decision-workspace"]);

  await dw("uninstall");
  expect(read(join(project, ".mcp.json"))).toEqual({
    mcpServers: { other: { command: "other-server" } },
  });
  expect(read().enabledMcpjsonServers).toBeUndefined();
});

test("--no-mcp installs only the hook", async () => {
  await dw("install", "--no-mcp");
  expect(existsSync(join(project, ".mcp.json"))).toBe(false);
  expect(read().enabledMcpjsonServers).toBeUndefined();
});

test("uninstall also removes a hook written by an older version (direct hook entry)", async () => {
  const legacy = '"/usr/local/bin/bun" "/x/apps/hook/src/main.ts"';
  mkdirSync(join(project, ".claude"));
  writeFileSync(
    settingsFile(),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: legacy }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: legacy }] }],
      },
    }),
  );
  await dw("uninstall");
  expect(read()).toEqual({});
});

test("dw hook (single binary entry) fails open without a daemon; dw version prints", async () => {
  const cli = join(import.meta.dir, "../../apps/cli/src/main.ts");
  const hook = Bun.spawn([process.execPath, cli, "hook"], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s" })]),
    stdout: "pipe",
    env: { ...process.env, DW_SOCKET: join(project, "none.sock") },
  });
  expect(await hook.exited).toBe(0);
  expect(await new Response(hook.stdout).text()).toBe("");
  expect((await dw("version")).out).toBe("dev");
  expect((await dw("--version")).out).toBe("dev");
});
