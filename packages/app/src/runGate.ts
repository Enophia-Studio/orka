import { mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { alive } from './radarLock';

/**
 * Why a run may not start: too many sessions run, another session works in an overlapping folder,
 * or another session runs the same CLI on another account profile.
 */
export type Refusal = { reason: 'budget'; running: number; max: number } | { reason: 'folder'; holder: string } | { reason: 'account'; account: string };

interface Hold {
  sessionId: string;
  /** The folder as the session names it (for notices). */
  root: string;
  /** The folder compared with others: its real path, lower-cased on Windows; undefined for a hold of accounts only. */
  key?: string;
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
 * to end (separate accounts are for separate work, never for running side by side), in every Orka
 * window and app on the machine when `shared` is given.
 */
export class RunGate {
  private readonly holds = new Set<Hold>();

  constructor(
    private readonly max: () => number,
    private readonly shared?: SharedAccounts,
  ) {}

  /** Runs under way. */
  get running(): number {
    return [...this.holds].filter((h) => h.run).length;
  }

  /** Start a run of `sessionId` in `root` on `accounts`; release() when it ends (more than once is harmless). */
  acquire(sessionId: string, root: string, accounts: readonly string[] = []): { ok: true; release(): void } | ({ ok: false } & Refusal) {
    const key = folderKey(root);
    const holder = this.holderNear(key, sessionId);
    if (holder) return { ok: false, reason: 'folder', holder: holder.root };
    const clash = this.clash(sessionId, accounts);
    if (clash) return clash;
    const running = this.running;
    const max = this.max();
    if (running >= max) return { ok: false, reason: 'budget', running, max };
    return { ok: true, release: this.add({ sessionId, root, key, run: true, accounts: [...accounts] }) };
  }

  /**
   * Hold CLI accounts for work that has no folder and no place in the budget (a Radar analysis on
   * Claude Code): refused while another profile of the same CLI runs.
   */
  holdAccounts(holderId: string, accounts: readonly string[]): { ok: true; release(): void } | { ok: false; reason: 'account'; account: string } {
    const clash = this.clash(holderId, accounts);
    if (clash) return clash;
    return { ok: true, release: this.add({ sessionId: holderId, root: '', run: false, accounts: [...accounts] }) };
  }

  /** The profile ("" = the default one) a run under way uses for `cli`, in this window or another; undefined when none uses it. */
  profileInUse(cli: string): string | undefined {
    const account = this.localAccount(cli) ?? this.shared?.inUse(cli);
    return account === undefined ? undefined : account.slice(cli.length + 1);
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
    for (const hold of [...this.holds]) if (hold.sessionId === sessionId) this.remove(hold);
  }

  private add(hold: Hold): () => void {
    this.holds.add(hold);
    this.publish(hold);
    return () => this.remove(hold);
  }

  private remove(hold: Hold): void {
    if (this.holds.delete(hold)) this.publish(hold);
  }

  /** Tell the other windows which profile this one now runs each CLI of `hold` on (none: it runs none). */
  private publish(hold: Hold): void {
    for (const cli of new Set(hold.accounts.map(accountCli))) this.shared?.publish(cli, this.localAccount(cli));
  }

  /** The account a hold in this window uses for `cli`. */
  private localAccount(cli: string): string | undefined {
    for (const hold of this.holds) {
      const account = hold.accounts.find((a) => accountCli(a) === cli);
      if (account !== undefined) return account;
    }
    return undefined;
  }

  /** A refusal when another profile of a CLI in `accounts` runs, here or in another window. */
  private clash(holderId: string, accounts: readonly string[]): { ok: false; reason: 'account'; account: string } | undefined {
    for (const account of accounts) {
      const other = this.accountClash(account, holderId) ?? this.shared?.clash(account);
      if (other) return { ok: false, reason: 'account', account: other };
    }
    return undefined;
  }

  private holderNear(key: string, except?: string): Hold | undefined {
    return [...this.holds].find((h) => h.sessionId !== except && h.key !== undefined && overlaps(h.key, key));
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

/** A CLI id as it names a file: the catalog's own ids ("claude-code", "codex"), nothing else. */
const CLI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The CLI accounts every Orka process on the machine runs (each VS Code window and the desktop
 * app have a gate of their own): one file per process and CLI in a folder they all share,
 * "<cli>.<pid>.json" with the account it runs. A file whose process is gone is left over and goes.
 * Holds only Orka's own profile ids, never anything of the account itself.
 */
export class SharedAccounts {
  constructor(
    private readonly dir: string,
    private readonly pid = process.pid,
  ) {}

  /** Another process's account on the same CLI as `account` but another profile. */
  clash(account: string): string | undefined {
    const other = this.inUse(accountCli(account));
    return other !== undefined && other !== account ? other : undefined;
  }

  /** The account another live process runs `cli` on. */
  inUse(cli: string): string | undefined {
    if (!CLI_ID.test(cli)) return undefined;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      const [prefix, pidText, ext, ...rest] = name.split('.');
      const pid = Number(pidText);
      if (prefix !== cli || ext !== 'json' || rest.length || !Number.isSafeInteger(pid) || pid <= 0 || pid === this.pid) continue;
      const file = path.join(this.dir, name);
      if (!alive(pid)) {
        try {
          unlinkSync(file);
        } catch {
          /* gone already */
        }
        continue;
      }
      try {
        const account = (JSON.parse(readFileSync(file, 'utf8')) as { account?: unknown } | null)?.account;
        if (typeof account === 'string' && accountCli(account) === cli) return account;
      } catch {
        /* being written: read again on the next start */
      }
    }
    return undefined;
  }

  /** This process now runs `cli` on `account` (undefined: on none). */
  publish(cli: string, account: string | undefined): void {
    if (!CLI_ID.test(cli)) return;
    const file = path.join(this.dir, `${cli}.${this.pid}.json`);
    try {
      if (account === undefined) unlinkSync(file);
      else {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ account })}\n`, 'utf8');
      }
    } catch {
      /* the folder cannot be written: this window's own gate still holds */
    }
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
