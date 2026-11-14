#!/usr/bin/env bun
/** The Decision Workspace logo in block letters with a colour gradient (README hero, vhs). */
const GLYPHS: Record<string, string[]> = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  W: ["██╗    ██╗", "██║    ██║", "██║ █╗ ██║", "██║███╗██║", "╚███╔███╔╝", " ╚══╝╚══╝ "],
};

function banner(word: string): string[] {
  const rows = ["", "", "", "", "", ""];
  for (const ch of word) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    for (let i = 0; i < 6; i++) rows[i] += g[i];
  }
  return rows;
}

// Cyan → violet, column by column; the shadow (╗║╚═╝╔) is drawn dimmer.
const from = [0, 215, 255];
const to = [168, 85, 247];
function paint(line: string, width: number): string {
  let out = "";
  [...line].forEach((ch, x) => {
    const t = width <= 1 ? 0 : x / (width - 1);
    const [r, g, b] = from.map((f, i) => Math.round(f + ((to[i] as number) - f) * t)) as [
      number,
      number,
      number,
    ];
    const shadow = ch !== "█" && ch !== " ";
    const k = shadow ? 0.45 : 1;
    out += `\x1b[38;2;${Math.round(r * k)};${Math.round(g * k)};${Math.round(b * k)}m${ch}`;
  });
  return `${out}\x1b[0m`;
}

const lines = [...banner("DECISION"), "", ...banner("WORKSPACE")];
const width = Math.max(...lines.map((l) => [...l].length));
const pad = "  ";
console.log();
for (const l of lines) console.log(pad + paint(l, width));
console.log();
console.log(
  `${pad}\x1b[1mAnswer Claude Code's questions one at a time,\x1b[0m\x1b[38;2;150;150;150m in a workspace of their own.\x1b[0m`,
);
console.log();
console.log(`${pad}\x1b[38;2;120;120;120m$\x1b[0m brew install k-ishida814/tap/decision-workspace`);
console.log();
