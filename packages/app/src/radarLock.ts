import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';

/** A lock its owner has not refreshed for this long is left over (its pid may belong to another program by now). */
const STALE_MS = 3 * 60 * 60 * 1000;
/** A lock file without readable content (its writer stopped between creating and filling it) is left over after this long. */
const UNREADABLE_STALE_MS = 60_000;
/** What another window that creates the lock at the same moment can make the exclusive create fail with. */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

interface Holder {
  pid: number;
  token: string;
  at: string;
}

/**
 * Every Orka Desktop window shares <orka home>/radar, so one process at a time owns Radar: it polls
 * and analyzes, the other windows only read what it writes. The owner is whoever created the lock
 * file (exclusively), with its pid, a token of its own and the time it last refreshed it. A lock
 * whose process is gone, or that nobody refreshed for hours, is left over and the next window
 * takes it.
 */
export class RadarLock {
  private readonly token = randomUUID();
  private held = false;

  constructor(private readonly file: string) {}

  /**
   * True when this instance holds the lock afterwards: it refreshes its own lock, and takes one
   * that is free or left over. False while another live window holds it (or took it over).
   */
  async acquire(): Promise<boolean> {
    const current = await this.inspect();
    if (current?.holder?.token === this.token) {
      await fs.writeFile(this.file, this.content(), 'utf8');
      return (this.held = true);
    }
    // Ours a moment ago, and it does not read right now (a virus scanner has it open): still ours.
    if (this.held && current && !current.holder) return true;
    this.held = false;
    if (current && !leftOver(current)) return false;
    if (current) await fs.rm(this.file, { force: true }).catch(() => undefined);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      await fs.writeFile(this.file, this.content(), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      // Another window was quicker.
      if (CONTENDED.has((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
    return (this.held = true);
  }

  /** Give the lock up when this instance holds it. Synchronous, so it also runs right before the process exits. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      if (holderOf(readFileSync(this.file, 'utf8'))?.token === this.token) unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }

  private content(): string {
    return `${JSON.stringify({ pid: process.pid, token: this.token, at: new Date().toISOString() } satisfies Holder)}\n`;
  }

  /** The lock file now: its holder (when it reads well) and its age; undefined when there is none. */
  private async inspect(): Promise<{ holder?: Holder; modifiedMs: number } | undefined> {
    try {
      const [stat, raw] = await Promise.all([fs.stat(this.file), fs.readFile(this.file, 'utf8')]);
      return { holder: holderOf(raw), modifiedMs: stat.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // Being replaced right now: someone holds it.
      return { modifiedMs: Date.now() };
    }
  }
}

function holderOf(raw: string): Holder | undefined {
  try {
    const value = JSON.parse(raw) as Partial<Holder> | null;
    if (!value || !Number.isSafeInteger(value.pid) || value.pid! <= 0 || typeof value.token !== 'string' || typeof value.at !== 'string') return undefined;
    if (!Number.isFinite(Date.parse(value.at))) return undefined;
    return value as Holder;
  } catch {
    return undefined;
  }
}

function leftOver(lock: { holder?: Holder; modifiedMs: number }): boolean {
  if (!lock.holder) return Date.now() - lock.modifiedMs > UNREADABLE_STALE_MS;
  return !alive(lock.holder.pid) || Date.now() - Date.parse(lock.holder.at) > STALE_MS;
}

/** Whether a process with this pid runs (one that belongs to another user counts). */
function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
