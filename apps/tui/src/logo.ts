/**
 * The Decision Workspace logo: block letters ("ANSI Shadow" style) and its colours. Used by the
 * TUI's empty Current screen and by docs/media/demo/logo.ts (the README hero image).
 *
 * To change the colours, edit LOGO_COLORS (or set DW_LOGO_FROM / DW_LOGO_TO / DW_LOGO_SHADOW to
 * hex colours like "#FFD700" to try them without editing).
 */
export const LOGO_COLORS = {
  /** Left edge of the gradient. */
  from: "#00D7FF",
  /** Right edge of the gradient. */
  to: "#A855F7",
  /** How bright the shadow strokes (╗ ║ ╚ ═) are, relative to the letters (0–1). */
  shadow: 0.45,
};

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
    const g = GLYPHS[ch] as string[];
    for (let i = 0; i < 6; i++) rows[i] = `${rows[i] ?? ""}${g[i] ?? ""}`;
  }
  return rows;
}

/** "DECISION", a blank line, "WORKSPACE": 13 rows, 75 columns. */
export const LOGO_LINES: readonly string[] = [...banner("DECISION"), "", ...banner("WORKSPACE")];
export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => [...l].length));

type Rgb = [number, number, number];

function hex(value: string): Rgb {
  const h = value.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function colors() {
  const env = process.env;
  return {
    from: hex(env.DW_LOGO_FROM ?? LOGO_COLORS.from),
    to: hex(env.DW_LOGO_TO ?? LOGO_COLORS.to),
    shadow: Number(env.DW_LOGO_SHADOW ?? LOGO_COLORS.shadow),
  };
}

/** One run of characters that share a colour. */
export type LogoSegment = { text: string; color: string };

/**
 * A logo line split into coloured runs. The gradient goes left to right across `columns`
 * (sampled every `step` characters, so the TUI does not draw one span per character); shadow
 * strokes are dimmer than the letters.
 */
export function logoSegments(line: string, columns = LOGO_WIDTH, step = 1): LogoSegment[] {
  const { from, to, shadow } = colors();
  const out: LogoSegment[] = [];
  [...line].forEach((ch, x) => {
    const t = columns <= 1 ? 0 : (Math.floor(x / step) * step) / (columns - 1);
    const k = ch === "█" || ch === " " ? 1 : shadow;
    const color = toHex(
      from.map((f, i) => (f + ((to[i] as number) - f) * Math.min(1, t)) * k) as Rgb,
    );
    const last = out.at(-1);
    if (last && last.color === color) last.text += ch;
    else out.push({ text: ch, color });
  });
  return out;
}
