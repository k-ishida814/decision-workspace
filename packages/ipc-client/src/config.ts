/** Reading and writing the user config file (T-306). Works on Bun and Node. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_KEYS, Config, type ConfigKey } from "@dw/protocol";
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

/** The config with defaults filled in. A missing file means all defaults. */
export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return Config.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${path}: ${issue?.path.join(".")}: ${issue?.message}`);
  }
  return parsed.data;
}

export function getConfigValue(config: Config, key: ConfigKey): unknown {
  return key.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], config);
}

/** Validate and write one setting; returns the new config. */
export function setConfigValue(key: string, value: string, path = configPath()): Config {
  if (!(key in CONFIG_KEYS)) {
    throw new ConfigError(`unknown key "${key}". Known: ${Object.keys(CONFIG_KEYS).join(", ")}`);
  }
  const type = CONFIG_KEYS[key as ConfigKey];
  const typed = type === "number" ? Number(value) : value;
  if (type === "number" && (value.trim() === "" || Number.isNaN(typed))) {
    throw new ConfigError(`${key} must be a number`);
  }
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const [section, field] = key.split(".") as [string, string];
  const next = { ...current, [section]: { ...(current[section] as object), [field]: typed } };
  const parsed = Config.safeParse(next);
  if (!parsed.success) {
    throw new ConfigError(`${key}: ${parsed.error.issues[0]?.message}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path); // never leave a half-written config
  return parsed.data;
}
