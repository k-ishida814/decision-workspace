/**
 * Reading and writing settings (T-306, T-601). Works on Bun and Node.
 * User settings: ~/.decision-workspace/config.json. Per-project overrides (only `mode`):
 * <project>/.decision-workspace/config.json, which is not committed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_KEYS,
  Config,
  type ConfigKey,
  PROJECT_CONFIG_KEYS,
  ProjectConfig,
  type UiMode,
} from "@dw/protocol";
import { stateDir } from "./paths";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configPath(): string {
  return process.env.DW_CONFIG ?? join(stateDir(), "config.json");
}

export function projectConfigPath(project: string): string {
  return join(project, ".decision-workspace", "config.json");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

type Parsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };

function check<T>(path: string, result: Parsed<T>): T {
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigError(`${path}: ${issue?.path.join(".") || "config"}: ${issue?.message}`);
  }
  return result.data;
}

/** The config with defaults filled in. A missing file means all defaults. */
export function loadConfig(path = configPath()): Config {
  return check<Config>(path, Config.safeParse(readJson(path)));
}

export function loadProjectConfig(project: string): ProjectConfig {
  const path = projectConfigPath(project);
  return check<ProjectConfig>(path, ProjectConfig.safeParse(readJson(path)));
}

export type ModeSource = "project" | "user" | "default";

/** The mode in effect for a project and where it came from. */
export function resolveMode(
  project: string,
  userPath = configPath(),
): { mode: UiMode; source: ModeSource } {
  const local = loadProjectConfig(project).mode;
  if (local) return { mode: local, source: "project" };
  const user = readJson(userPath);
  const mode = loadConfig(userPath).mode;
  return { mode, source: "mode" in user ? "user" : "default" };
}

export function getConfigValue(config: Config, key: ConfigKey): unknown {
  return key.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], config);
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path); // never leave a half-written config
}

/** "agents.model" → { agents: { ...current.agents, model } }; "mode" → { mode }. */
function withValue(
  current: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const [section, field] = key.split(".") as [string, string | undefined];
  if (!field) return { ...current, [section]: value };
  return { ...current, [section]: { ...(current[section] as object), [field]: value } };
}

/** Validate and write one user setting; returns the new config. */
export function setConfigValue(key: string, value: string, path = configPath()): Config {
  if (!(key in CONFIG_KEYS)) {
    throw new ConfigError(`unknown key "${key}". Known: ${Object.keys(CONFIG_KEYS).join(", ")}`);
  }
  const type = CONFIG_KEYS[key as ConfigKey];
  const typed = type === "number" ? Number(value) : value;
  if (type === "number" && (value.trim() === "" || Number.isNaN(typed))) {
    throw new ConfigError(`${key} must be a number`);
  }
  const next = withValue(readJson(path), key, typed);
  const parsed = Config.safeParse(next);
  if (!parsed.success) throw new ConfigError(`${key}: ${parsed.error.issues[0]?.message}`);
  writeAtomic(path, next);
  return parsed.data;
}

/** Validate and write one per-project override (`--local`). */
export function setProjectConfigValue(project: string, key: string, value: string): ProjectConfig {
  if (!(PROJECT_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new ConfigError(
      `"${key}" cannot be set per project. Per-project keys: ${PROJECT_CONFIG_KEYS.join(", ")}`,
    );
  }
  const path = projectConfigPath(project);
  const next = withValue(readJson(path), key, value);
  const parsed = ProjectConfig.safeParse(next);
  if (!parsed.success) throw new ConfigError(`${key}: ${parsed.error.issues[0]?.message}`);
  writeAtomic(path, next);
  return parsed.data;
}

/** Remove a per-project override, so the user setting applies again. */
export function unsetProjectConfigValue(project: string, key: string): void {
  const path = projectConfigPath(project);
  const current = readJson(path);
  if (!(key in current)) return;
  const { [key]: _removed, ...rest } = current;
  writeAtomic(path, rest);
}
