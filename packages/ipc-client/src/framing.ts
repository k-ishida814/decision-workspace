/** Newline-delimited JSON framing (ADR-0004). */
export class LineDecoder {
  private buffer = "";

  /** Feed a chunk; returns every complete line it finished. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((l) => l.trim().length > 0);
  }
}

export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
