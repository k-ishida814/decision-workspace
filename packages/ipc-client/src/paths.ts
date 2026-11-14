/** Locations shared by the daemon and its clients (ADR-0004). Works on Bun and Node. */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function stateDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, "decision-workspace") : join(homedir(), ".decision-workspace");
}

export function defaultSocketPath(): string {
  return process.env.DW_SOCKET ?? join(stateDir(), "daemon.sock");
}

const ROOT_MARKERS = [".decision-workspace", ".jj", ".git"];

/**
 * One spelling per directory, so every client agrees on the project key. Resolves symlinks
 * (macOS: /tmp → /private/tmp, which is how Claude Code reports cwd) even for paths that do not
 * exist yet, by resolving the nearest existing ancestor.
 */
export function canonicalPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return join(existing, ...rest);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Nearest ancestor that looks like a project root; falls back to `cwd` itself. */
export function findProjectRoot(cwd: string): string {
  const start = canonicalPath(cwd);
  let dir = start;
  for (;;) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
