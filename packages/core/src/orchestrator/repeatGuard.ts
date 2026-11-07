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
/** In a code block a line must repeat this many times more often to count. */
const CODE_FACTOR = 10;

export class RepeatGuard {
  private partial = '';
  private last = '';
  private count = 0;
  /** The fence (``` or ~~~) of the code block the answer is in, if any. */
  private fence = '';

  constructor(private readonly limit = REPEAT_LIMIT) {}

  /**
   * Streamed answer text; returns the repeated line once it came `limit` times in a row. Blank lines
   * between them do not count. In a code block (a tilemap, a YAML excerpt) a line may repeat on
   * purpose, so there it takes CODE_FACTOR times as many.
   */
  push(text: string): string | undefined {
    this.partial += text;
    let newline: number;
    while ((newline = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, newline).trim();
      this.partial = this.partial.slice(newline + 1);
      if (!line) continue;
      const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
      const opens = !this.fence && marker !== undefined;
      const closes = this.fence !== '' && line === marker && marker.startsWith(this.fence);
      if (opens || closes) {
        this.fence = opens ? marker! : '';
        this.last = '';
        this.count = 0;
        continue;
      }
      const limit = this.fence ? this.limit * CODE_FACTOR : this.limit;
      if (line.length <= MAX_LINE && line === this.last) this.count++;
      else {
        this.last = line;
        this.count = 1;
      }
      if (this.count >= limit) return line;
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
