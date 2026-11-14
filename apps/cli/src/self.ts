/**
 * How to run this `dw` again from outside (daemon auto-start, Claude Code hook and MCP entries).
 * Released: the single compiled binary. Development: bun + this package's main.ts.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** `bun build --compile` serves the bundled sources from this virtual file system. */
export const isCompiled = (): boolean => Bun.main.startsWith("/$bunfs/");

export function selfCommand(): string[] {
  if (!isCompiled()) return [process.execPath, join(import.meta.dir, "main.ts")];
  // Prefer the stable path on PATH (Homebrew: /opt/homebrew/bin/dw) over the versioned Cellar
  // path, so settings written by `dw install` survive `brew upgrade`.
  const onPath = Bun.which("dw");
  try {
    if (onPath && realpathSync(onPath) === realpathSync(process.execPath)) return [onPath];
  } catch {
    // fall through
  }
  return [process.execPath];
}
