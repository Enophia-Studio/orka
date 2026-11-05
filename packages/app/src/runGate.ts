import { realpathSync } from 'node:fs';
import * as path from 'node:path';

/** Why a run may not start: too many sessions run, or another session works in an overlapping folder. */
export type Refusal = { reason: 'budget'; running: number; max: number } | { reason: 'folder'; holder: string };

interface Hold {
  sessionId: string;
  /** The folder as the session names it (for notices). */
  root: string;
  /** The folder compared with others: its real path, lower-cased on Windows. */
  key: string;
  /** A run counts toward the budget; a hand-off only holds its folder. */
  run: boolean;
}

/**
 * Which sessions may run at once. Runs count toward a budget (each may start an agent CLI or a
 * Claude Code process), and two sessions never work in folders that overlap (the same folder under
 * another name, or one inside the other), or their change tracking would take each other's edits
 * for their own. An open hand-off holds its folder too, but does not count toward the budget.
 */
export class RunGate {
  private readonly holds = new Set<Hold>();

  constructor(private readonly max: () => number) {}

  /** Runs under way. */
  get running(): number {
    return [...this.holds].filter((h) => h.run).length;
  }

  /** Start a run of `sessionId` in `root`; release() when it ends (more than once is harmless). */
  acquire(sessionId: string, root: string): { ok: true; release(): void } | ({ ok: false } & Refusal) {
    const key = folderKey(root);
    const holder = this.holderNear(key, sessionId);
    if (holder) return { ok: false, reason: 'folder', holder: holder.root };
    const running = this.running;
    const max = this.max();
    if (running >= max) return { ok: false, reason: 'budget', running, max };
    return { ok: true, release: this.add({ sessionId, root, key, run: true }) };
  }

  /**
   * The folder of a session (other than `except`) that runs, or has a hand-off open, in a folder
   * overlapping `root`; undefined when there is none.
   */
  busyNear(root: string, except?: string): string | undefined {
    return this.holderNear(folderKey(root), except)?.root;
  }

  /** An open hand-off holds its folder until the returned function is called: no other session runs there. */
  holdFolder(sessionId: string, root: string): () => void {
    return this.add({ sessionId, root, key: folderKey(root), run: false });
  }

  /** Let go of everything a session holds (it goes away while a run of it may still be winding down). */
  releaseAll(sessionId: string): void {
    for (const hold of [...this.holds]) if (hold.sessionId === sessionId) this.holds.delete(hold);
  }

  private add(hold: Hold): () => void {
    this.holds.add(hold);
    return () => void this.holds.delete(hold);
  }

  private holderNear(key: string, except?: string): Hold | undefined {
    return [...this.holds].find((h) => h.sessionId !== except && overlaps(h.key, key));
  }
}

/** A folder as the gate compares it: where it really leads (links and aliases resolved), case-folded on Windows. */
export function folderKey(root: string): string {
  let real: string;
  try {
    real = realpathSync.native(root);
  } catch {
    real = path.resolve(root);
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Two folder keys are the same folder, or one is inside the other ("/a/app" and "/a/app2" are not). */
export function overlaps(a: string, b: string): boolean {
  return a === b || inside(a, b) || inside(b, a);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
