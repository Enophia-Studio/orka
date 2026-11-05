import { realpathSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Why a run may not start: too many sessions run, another session works in an overlapping folder,
 * or another session runs the same CLI on another account profile.
 */
export type Refusal = { reason: 'budget'; running: number; max: number } | { reason: 'folder'; holder: string } | { reason: 'account'; account: string };

interface Hold {
  sessionId: string;
  /** The folder as the session names it (for notices). */
  root: string;
  /** The folder compared with others: its real path, lower-cased on Windows. */
  key: string;
  /** A run counts toward the budget; a hand-off only holds its folder. */
  run: boolean;
  /** The CLI account profiles the run uses, as "<cli>:<profile>" ("claude-code:" = the default profile). */
  accounts: readonly string[];
}

/**
 * Which sessions may run at once. Runs count toward a budget (each may start an agent CLI or a
 * Claude Code process), and two sessions never work in folders that overlap (the same folder under
 * another name, or one inside the other), or their change tracking would take each other's edits
 * for their own. An open hand-off holds its folder too, but does not count toward the budget. One
 * profile of a CLI runs at a time: a run on another profile of the same CLI waits for the first
 * to end (separate accounts are for separate work, never for running side by side).
 */
export class RunGate {
  private readonly holds = new Set<Hold>();

  constructor(private readonly max: () => number) {}

  /** Runs under way. */
  get running(): number {
    return [...this.holds].filter((h) => h.run).length;
  }

  /** Start a run of `sessionId` in `root` on `accounts`; release() when it ends (more than once is harmless). */
  acquire(sessionId: string, root: string, accounts: readonly string[] = []): { ok: true; release(): void } | ({ ok: false } & Refusal) {
    const key = folderKey(root);
    const holder = this.holderNear(key, sessionId);
    if (holder) return { ok: false, reason: 'folder', holder: holder.root };
    for (const account of accounts) {
      const other = this.accountClash(account, sessionId);
      if (other) return { ok: false, reason: 'account', account: other };
    }
    const running = this.running;
    const max = this.max();
    if (running >= max) return { ok: false, reason: 'budget', running, max };
    return { ok: true, release: this.add({ sessionId, root, key, run: true, accounts: [...accounts] }) };
  }

  /** The profile ("" = the default one) a run under way uses for `cli`; undefined when none uses it. */
  profileInUse(cli: string): string | undefined {
    for (const hold of this.holds) {
      const account = hold.accounts.find((a) => accountCli(a) === cli);
      if (account !== undefined) return account.slice(cli.length + 1);
    }
    return undefined;
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
    return this.add({ sessionId, root, key: folderKey(root), run: false, accounts: [] });
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

  /** Another session's account on the same CLI as `account` but another profile. */
  private accountClash(account: string, except: string): string | undefined {
    const cli = accountCli(account);
    for (const hold of this.holds) {
      if (hold.sessionId === except) continue;
      const other = hold.accounts.find((a) => accountCli(a) === cli && a !== account);
      if (other) return other;
    }
    return undefined;
  }
}

/** "claude-code" of "claude-code:work". */
function accountCli(account: string): string {
  const colon = account.indexOf(':');
  return colon < 0 ? account : account.slice(0, colon);
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
