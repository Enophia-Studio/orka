/**
 * Notices a model caught in a loop: its answer repeats the same short line over and over, which
 * would otherwise flood the transcript (and use up tokens) until the output limit.
 */

/** Lines in a row that count as a loop. */
export const REPEAT_LIMIT = 30;
/** Longer lines never count: real text rarely repeats a long line, and a loop of them shows soon enough. */
const MAX_LINE = 160;
/** A line that is still streaming is kept up to this many characters. */
const MAX_PARTIAL = 4096;

export class RepeatGuard {
  private partial = '';
  private last = '';
  private count = 0;

  constructor(private readonly limit = REPEAT_LIMIT) {}

  /** Streamed answer text; returns the repeated line once it came `limit` times in a row. Blank lines between them do not count. */
  push(text: string): string | undefined {
    this.partial += text;
    let newline: number;
    while ((newline = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, newline).trim();
      this.partial = this.partial.slice(newline + 1);
      if (!line) continue;
      if (line.length <= MAX_LINE && line === this.last) this.count++;
      else {
        this.last = line;
        this.count = 1;
      }
      if (this.count >= this.limit) return line;
    }
    if (this.partial.length > MAX_PARTIAL) this.partial = this.partial.slice(-MAX_PARTIAL);
    return undefined;
  }
}

/** The text with each run of `line` (and the blank lines inside it) cut to its first occurrence. */
export function collapseRepeats(text: string, line: string): string {
  const kept: string[] = [];
  let lastLine = '';
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === line && lastLine === line) continue;
    if (!trimmed && lastLine === line) continue;
    kept.push(raw);
    if (trimmed) lastLine = trimmed;
  }
  return kept.join('\n').trim();
}
