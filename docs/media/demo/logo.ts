#!/usr/bin/env bun
/**
 * Prints the logo for the README hero image (docs/media/tapes/hero.tape). The letters and colours
 * live in apps/tui/src/logo.ts (LOGO_COLORS), shared with the TUI. Try colours without editing:
 *   DW_LOGO_FROM=#FFD700 DW_LOGO_TO=#FFFFFF bun docs/media/demo/logo.ts
 */
import { LOGO_LINES, logoSegments } from "../../../apps/tui/src/logo";

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");
const pad = "  ";

console.log();
for (const line of LOGO_LINES) {
  const painted = logoSegments(line)
    .map((s) => `\x1b[38;2;${rgb(s.color)}m${s.text}`)
    .join("");
  console.log(`${pad}${painted}\x1b[0m`);
}
console.log();
// Tagline: bold white, then grey. brew line: grey prompt.
console.log(
  `${pad}\x1b[1mAnswer Claude Code's questions one at a time,\x1b[0m\x1b[38;2;150;150;150m in a workspace of their own.\x1b[0m`,
);
console.log();
console.log(`${pad}\x1b[38;2;120;120;120m$\x1b[0m brew install k-ishida814/tap/decision-workspace`);
console.log();
