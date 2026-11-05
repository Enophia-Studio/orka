import * as path from 'node:path';
import { programPath } from '../host/commands';
import type { Host } from '../host/Host';
import { acceptHunkIn, type DiffHunk, diffLines, hunkHeader, hunksBetween, lineStats, revertHunkIn, splitLines, unifiedDiff } from './diff';
import { mergeText } from './ShadowGit';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileChange {
  absPath: string;
  relPath: string;
  status: ChangeStatus;
  /** Line counts from a line diff. */
  added: number;
  removed: number;
  /** The user edited this file by hand after the agent; Revert leaves it alone. */
  userEdited?: true;
}

/** A file's content before the agent first touched it, as stored with a task (checkpoint). */
export interface ChangeCheckpoint {
  /** Workspace-relative path with forward slashes. */
  path: string;
  /** null: the file did not exist. */
  original: string | null;
  /**
   * The user edited the file by hand after the agent: the file's content before their first save
   * and what they saved (to undo only the agent's part later), or true when those were too large
   * to store.
   */
  userEdited?: { aiContent: string; saved: string } | true;
}

/** What Revert of a user-edited file that undoes only the agent's part did. */
export type AgentPartRevert = 'reverted' | 'conflict' | 'unavailable' | 'changed' | 'notApplicable';

/** A file the user saved by hand after the agent changed it. */
interface UserEdit {
  /** The rewind point that was the latest when the user last saved (-1: none, or compacted since). */
  epoch: number;
  /** The file before the user's first save; undefined when unknown (restored from a large checkpoint). */
  aiContent?: string;
  /** What the user last saved; undefined when unknown. */
  saved?: string;
  /**
   * The tracked original predates the save, so Revert would throw the user's edit away. False once
   * the change was kept (or undone): the entry then only keeps Go back from restoring older content.
   */
  guardsRevert: boolean;
}

/** Originals larger than this are not stored with a task (the file can still be reverted until then). */
const MAX_CHECKPOINT_FILE = 1_000_000;
const MAX_CHECKPOINT_TOTAL = 8_000_000;

/**
 * Snapshots each file the first time the agent touches it, so every AI change can be shown as
 * a diff, accepted (snapshot dropped) or reverted (snapshot restored) - individually or all.
 */
export class ChangeTracker {
  /** absPath -> content before the agent first touched it (null = file did not exist). */
  private originals = new Map<string, string | null>();
  /**
   * Rewind points: each epoch (one per user request) keeps the content of every file as it was
   * when that epoch began, captured the first time the file changes during it.
   */
  private epochs: Array<Map<string, string | null>> = [];
  /** Files the user saved by hand after the agent changed them; key: editKey(absPath). */
  private userEdits = new Map<string, UserEdit>();
  private listeners = new Set<() => void>();

  constructor(private readonly host: Host) {}

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Call before modifying/deleting a file. Only the first snapshot per file (and per epoch) is kept.
   * Once `current` says no (the tracker now holds another task), nothing is recorded.
   */
  async recordBefore(absPath: string, current: () => boolean = () => true): Promise<void> {
    const key = normalize(absPath);
    const epoch = this.epochs.at(-1);
    if (this.originals.has(key) && (!epoch || epoch.has(key))) return;
    const content = (await this.host.exists(absPath)) ? await this.host.readFile(absPath) : null;
    if (!current()) return;
    if (!this.originals.has(key)) this.originals.set(key, content);
    if (epoch && !epoch.has(key)) epoch.set(key, content);
  }

  /** Record a known original (e.g. from a snapshot taken before a command); only the first one counts. */
  recordOriginal(absPath: string, original: string | null): void {
    const key = normalize(absPath);
    if (!this.originals.has(key)) this.originals.set(key, original);
    const epoch = this.epochs.at(-1);
    if (epoch && !epoch.has(key)) epoch.set(key, original);
  }

  /** Start a rewind point here; returns its number for rewindTo. */
  startEpoch(): number {
    this.epochs.push(new Map());
    return this.epochs.length - 1;
  }

  /** Forget all rewind points (files stay as they are). Revert still leaves user-edited files alone. */
  clearEpochs(): void {
    this.epochs = [];
    for (const edit of this.userEdits.values()) edit.epoch = -1;
    this.pruneEdits();
  }

  /**
   * Put every file changed since rewind point `epoch` back the way it was then, and drop that
   * point and the later ones. A restored file the tracker no longer followed (its change was kept)
   * is followed again from its current content, so the rewind itself shows up as a reviewable change.
   * A file the user saved by hand after its content at that point was captured is kept as it is.
   */
  async rewindTo(epoch: number): Promise<{ restored: string[]; kept: string[] }> {
    const plan = await this.rewindPlan(epoch);
    if (!plan) return { restored: [], kept: [] };
    this.epochs = this.epochs.slice(0, epoch);
    // A rewind point made from here on is captured after every save so far.
    for (const edit of this.userEdits.values()) edit.epoch = Math.min(edit.epoch, epoch - 1);
    for (const { key, content, current } of plan.restore) {
      if (!this.originals.has(key)) this.originals.set(key, current);
      if (content === null) await this.host.deleteFile(key);
      else await this.host.writeFile(key, content);
      // Earlier rewind points still hold their own older captures of this file.
    }
    this.pruneEdits();
    this.notify();
    return { restored: plan.restore.map((r) => this.relative(r.key)).sort(), kept: plan.keep.map((key) => this.relative(key)).sort() };
  }

  /** What rewindTo(epoch) would restore and keep (workspace-relative paths), without writing anything. */
  async rewindPreview(epoch: number): Promise<{ restore: string[]; keep: string[] }> {
    const plan = await this.rewindPlan(epoch);
    return { restore: (plan?.restore ?? []).map((r) => this.relative(r.key)).sort(), keep: (plan?.keep ?? []).map((key) => this.relative(key)).sort() };
  }

  private async rewindPlan(epoch: number): Promise<{ restore: Array<{ key: string; content: string | null; current: string | null }>; keep: string[] } | undefined> {
    if (epoch < 0 || epoch >= this.epochs.length) return undefined;
    // The earliest capture wins: it is the content when the rewind point began. Remember which point captured it.
    const target = new Map<string, { content: string | null; epoch: number }>();
    this.epochs.slice(epoch).forEach((map, i) => {
      for (const [key, content] of map) if (!target.has(key)) target.set(key, { content, epoch: epoch + i });
    });
    const restore: Array<{ key: string; content: string | null; current: string | null }> = [];
    const keep: string[] = [];
    for (const [key, { content, epoch: captured }] of target) {
      const current = await this.current(key);
      if (current === content) continue;
      // Captures of a point are taken while its request runs, and saves wait until it stops: a save
      // noted in that point or later came after the capture, which would undo it.
      const edit = this.userEdits.get(editKey(key));
      if (edit && edit.epoch >= captured) keep.push(key);
      else restore.push({ key, content, current });
    }
    return { restore, keep };
  }

  /** Call after modifying a file to notify listeners. */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  getOriginal(absPath: string): string | null | undefined {
    return this.originals.get(normalize(absPath));
  }

  isTracked(absPath: string): boolean {
    return this.originals.has(normalize(absPath));
  }

  /** The current rewind point already holds this file's earlier content (true when there is no rewind point). */
  capturedInEpoch(absPath: string): boolean {
    return this.epochs.at(-1)?.has(normalize(absPath)) ?? true;
  }

  /**
   * The user saved `absPath` by hand (in the editor), replacing `before` with `after` (the full
   * texts, byte for byte). Only a file the agent changed in this task counts: Revert, Go back and
   * hunk Revert then leave the user's edit alone. A save that changed nothing is ignored.
   */
  noteUserEdit(absPath: string, before: string, after: string): void {
    if (before === after) return;
    const key = editKey(absPath);
    const tracked = [...this.originals.keys()].some((k) => editKey(k) === key);
    if (!tracked && !this.epochs.some((map) => [...map.keys()].some((k) => editKey(k) === key))) return;
    const earlier = this.userEdits.get(key);
    // Later saves keep the agent's content from before the first one, while the same change is open.
    const aiContent = earlier?.guardsRevert ? earlier.aiContent : before;
    this.userEdits.set(key, { epoch: this.epochs.length - 1, aiContent, saved: after, guardsRevert: tracked || !!earlier?.guardsRevert });
    this.notify();
  }

  /** The user edited this changed file by hand after the agent, so Revert leaves it alone. */
  isUserEdited(absPath: string): boolean {
    return this.userEdits.get(editKey(absPath))?.guardsRevert ?? false;
  }

  /** Changed files Revert All leaves alone because the user edited them (workspace-relative paths). */
  skippedUserEdited(): string[] {
    return [...this.originals.keys()]
      .filter((key) => this.isUserEdited(key))
      .map((key) => this.relative(key))
      .sort();
  }

  /** Current net changes; files edited back to their original content are omitted. */
  async list(): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    for (const [absPath, original] of this.originals) {
      const exists = await this.host.exists(absPath);
      const current = exists ? await this.host.readFile(absPath) : null;
      let status: ChangeStatus | undefined;
      if (original === null) status = exists ? 'added' : undefined;
      else if (!exists) status = 'deleted';
      else if (current !== original) status = 'modified';
      if (!status) this.unguard(absPath);
      else changes.push({ absPath, relPath: this.relative(absPath), status, ...lineStats(original, current), ...(this.isUserEdited(absPath) ? { userEdited: true as const } : {}) });
    }
    return changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** Keep the change: forget the snapshot. */
  accept(absPath: string): void {
    this.originals.delete(normalize(absPath));
    this.unguard(absPath);
    this.notify();
  }

  acceptAll(): void {
    for (const key of this.originals.keys()) this.unguard(key);
    this.originals.clear();
    this.notify();
  }

  /**
   * Restore the file to its state before the agent touched it. A file the user edited by hand after
   * the agent is left alone unless `force` is set. True when the file was restored.
   */
  async revert(absPath: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const key = normalize(absPath);
    if (!this.originals.has(key)) return false;
    if (this.isUserEdited(key) && !opts.force) return false;
    const original = this.originals.get(key)!;
    if (original === null) await this.host.deleteFile(key);
    else await this.host.writeFile(key, original);
    this.originals.delete(key);
    this.userEdits.delete(editKey(key));
    this.notify();
    return true;
  }

  /**
   * Revert of a file the user edited after the agent: undo only the agent's lines and keep the
   * user's, by a three-way merge (git merge-file) that applies the change from the agent's content
   * back to the original onto the file as it is now. Written only when the merge is clean and the
   * file is still exactly what the user saved. `unavailable` without git (or without the texts,
   * after a large task was reopened); `notApplicable` for a file that is not user-edited, or was
   * added or deleted.
   */
  async revertAgentPart(absPath: string): Promise<AgentPartRevert> {
    const key = normalize(absPath);
    const edit = this.userEdits.get(editKey(key));
    const original = this.originals.get(key);
    if (!edit?.guardsRevert || original === undefined || original === null) return 'notApplicable';
    const current = await this.current(key);
    if (current === null) return 'notApplicable';
    if (edit.aiContent === undefined || edit.saved === undefined) return 'unavailable';
    if (current !== edit.saved) return 'changed';
    if (!programPath('git')) return 'unavailable';
    const merged = await mergeText(current, edit.aiContent, original);
    if (!merged.clean) return 'conflict';
    // The merge ran in another process: the file must not have changed meanwhile.
    if ((await this.current(key)) !== edit.saved || this.userEdits.get(editKey(key)) !== edit) return 'changed';
    await this.host.writeFile(key, merged.text);
    this.originals.delete(key);
    this.unguard(key);
    this.notify();
    return 'reverted';
  }

  /** Revert every changed file except those the user edited by hand; returns the files reverted. */
  async revertAll(): Promise<string[]> {
    const reverted: string[] = [];
    for (const absPath of [...this.originals.keys()]) if (await this.revert(absPath)) reverted.push(this.relative(absPath));
    return reverted;
  }

  /** Hunks of a tracked file's net change (empty when unchanged or untracked). */
  async hunks(absPath: string): Promise<DiffHunk[]> {
    const key = normalize(absPath);
    if (!this.originals.has(key)) return [];
    return hunksBetween(this.originals.get(key)!, await this.current(key));
  }

  /**
   * Hunk `index` of the file's change includes or borders lines the user edited by hand. When the
   * file is no longer what the user saved (or that is unknown), every hunk counts as touching.
   */
  async hunkTouchesUserEdit(absPath: string, index: number): Promise<boolean> {
    const key = normalize(absPath);
    const original = this.originals.get(key);
    const current = await this.current(key);
    if (original === undefined || current === null) return false;
    const hunk = hunksBetween(original, current)[index];
    return !!hunk && this.touchesUserEdit(key, current, hunk);
  }

  /**
   * Undo one hunk of a modified file, leaving the rest of the AI's change in place. Added and
   * deleted files are reverted as a whole instead. Returns false if the hunk no longer exists, is
   * not the one `header` names (the change moved on since it was shown), or includes lines the
   * user edited by hand (unless `force` is set).
   */
  async revertHunk(absPath: string, index: number, opts: { header?: string; force?: boolean } = {}): Promise<boolean> {
    const key = normalize(absPath);
    const original = this.originals.get(key);
    const current = await this.current(key);
    if (original === undefined || original === null || current === null) return false;
    const hunk = hunksBetween(original, current)[index];
    if (!hunk) return false;
    if (opts.header !== undefined && hunkHeader(hunk) !== opts.header) return false;
    if (!opts.force && this.touchesUserEdit(key, current, hunk)) return false;
    const next = revertHunkIn(current, hunk);
    await this.host.writeFile(key, next);
    const edit = this.userEdits.get(editKey(key));
    if (edit?.aiContent !== undefined && edit.saved === current) {
      // The user's lines stayed as they are: undo the hunk in the agent's content too, so the
      // user's edit can still be told apart from the agent's (unknown when that fails).
      edit.aiContent = carryOver(edit.aiContent, current, next);
      edit.saved = edit.aiContent === undefined ? undefined : next;
    }
    if (next === original) {
      this.originals.delete(key);
      this.unguard(key);
    }
    this.notify();
    return true;
  }

  /**
   * Keep one hunk of a modified file (the rest stays reviewable): its new lines become part of the
   * snapshot. Returns false if the hunk no longer exists.
   */
  async acceptHunk(absPath: string, index: number): Promise<boolean> {
    const key = normalize(absPath);
    const original = this.originals.get(key);
    const current = await this.current(key);
    if (original === undefined || original === null || current === null) return false;
    const hunk = hunksBetween(original, current)[index];
    if (!hunk) return false;
    const next = acceptHunkIn(original, hunk);
    if (next === current) {
      this.originals.delete(key);
      this.unguard(key);
    } else this.originals.set(key, next);
    this.notify();
    return true;
  }

  /** Unified diff of every net change, for reviewers; long output is cut at `maxChars`. */
  async unifiedDiffs(maxChars = 20_000): Promise<string> {
    const parts: string[] = [];
    let size = 0;
    for (const change of await this.list()) {
      const diff = unifiedDiff(change.relPath, this.originals.get(normalize(change.absPath)) ?? null, await this.current(change.absPath));
      if (size + diff.length > maxChars) {
        parts.push(`... diff of ${change.relPath} and later files omitted (${change.status}, +${change.added} -${change.removed})`);
        break;
      }
      parts.push(diff);
      size += diff.length;
    }
    return parts.join('\n');
  }

  /** Originals of all tracked files, to store with a task so it can be reverted after reopening. */
  exportCheckpoint(): ChangeCheckpoint[] {
    const out: ChangeCheckpoint[] = [];
    let total = 0;
    for (const [absPath, original] of this.originals) {
      const size = original?.length ?? 0;
      if (size > MAX_CHECKPOINT_FILE || total + size > MAX_CHECKPOINT_TOTAL) continue;
      total += size;
      const entry: ChangeCheckpoint = { path: this.relative(absPath), original };
      const edit = this.userEdits.get(editKey(absPath));
      if (edit?.guardsRevert) {
        // Too large to store: the flag alone still keeps Revert away from the user's edit.
        const texts = edit.aiContent !== undefined && edit.saved !== undefined ? edit.aiContent.length + edit.saved.length : Infinity;
        if (texts > MAX_CHECKPOINT_FILE || total + texts > MAX_CHECKPOINT_TOTAL) entry.userEdited = true;
        else {
          total += texts;
          entry.userEdited = { aiContent: edit.aiContent!, saved: edit.saved! };
        }
      }
      out.push(entry);
    }
    return out;
  }

  /** Replace the tracked originals with a stored checkpoint (paths outside the workspace are ignored). */
  importCheckpoint(entries: readonly ChangeCheckpoint[]): void {
    this.originals.clear();
    this.epochs = [];
    this.userEdits.clear();
    const root = path.resolve(this.host.workspaceRoot);
    for (const entry of entries) {
      if (typeof entry?.path !== 'string' || (entry.original !== null && typeof entry.original !== 'string')) continue;
      const abs = path.resolve(root, entry.path);
      const inside = path.relative(root, abs);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue;
      this.originals.set(normalize(abs), entry.original);
      const edited = entry.userEdited;
      if (edited === true) this.userEdits.set(editKey(abs), { epoch: -1, guardsRevert: true });
      else if (typeof edited?.aiContent === 'string' && typeof edited.saved === 'string') {
        this.userEdits.set(editKey(abs), { epoch: -1, aiContent: edited.aiContent, saved: edited.saved, guardsRevert: true });
      }
    }
    this.notify();
  }

  /** Forget every snapshot without touching files (a new task starts with a clean change list). */
  clear(): void {
    this.epochs = [];
    this.userEdits.clear();
    if (!this.originals.size) return;
    this.originals.clear();
    this.notify();
  }

  private async current(absPath: string): Promise<string | null> {
    return (await this.host.exists(absPath)) ? this.host.readFile(absPath) : null;
  }

  private relative(absPath: string): string {
    return path.relative(this.host.workspaceRoot, absPath).split(path.sep).join('/');
  }

  /**
   * The hunk (of the change from the original to `current`) includes or borders a line the user
   * changed relative to the agent's content. Both are compared in `current`'s line numbers.
   */
  private touchesUserEdit(key: string, current: string, hunk: DiffHunk): boolean {
    const edit = this.userEdits.get(editKey(key));
    if (!edit?.guardsRevert) return false;
    if (edit.aiContent === undefined || edit.saved !== current) return true;
    const user = changedRanges(edit.aiContent, current);
    const agent: Array<[number, number]> = [];
    let line = hunk.newStart;
    for (const l of hunk.lines) {
      if (l.type === '+') agent.push([line, ++line]);
      else if (l.type === '-') agent.push([line - 1, line + 1]);
      else line++;
    }
    return agent.some(([a, b]) => user.some(([c, d]) => a < d && c < b));
  }

  /** The change no longer reaches back to before the user's save: Revert may touch the file again. */
  private unguard(absPath: string): void {
    const edit = this.userEdits.get(editKey(absPath));
    if (!edit) return;
    edit.guardsRevert = false;
    this.pruneEdits();
  }

  /** Drop user edits nothing needs any more: no Revert to guard and no rewind point holding the file. */
  private pruneEdits(): void {
    if (![...this.userEdits.values()].some((edit) => !edit.guardsRevert)) return;
    const captured = new Set(this.epochs.flatMap((map) => [...map.keys()].map(editKey)));
    for (const [key, edit] of this.userEdits) if (!edit.guardsRevert && !captured.has(key)) this.userEdits.delete(key);
  }
}

function normalize(absPath: string): string {
  const resolved = path.resolve(absPath);
  return process.platform === 'win32' ? resolved.replace(/^[a-z]:/, (d) => d.toUpperCase()) : resolved;
}

/**
 * The key of a user edit: also case-insensitive on Windows, where the agent and the editor may name
 * the same file in different case. A missed match must never leave a user's edit unprotected.
 */
function editKey(absPath: string): string {
  const key = normalize(absPath);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * Lines of `current` that differ from `base`, as [start, end) line ranges in `current`. A line
 * removed from `base` counts as the point between two lines, covering both neighbours.
 */
function changedRanges(base: string, current: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let line = 0;
  for (const op of diffLines(splitLines(base), splitLines(current))) {
    if (op.type === 'insert') ranges.push([line, ++line]);
    else if (op.type === 'delete') ranges.push([line - 1, line + 1]);
    else line++;
  }
  return ranges;
}

/**
 * `base` with the change from `current` to `next` applied, where that change only touches lines
 * `base` and `current` share, with a shared line (or the start or end of the file) on either side;
 * undefined otherwise.
 */
function carryOver(base: string, current: string, next: string): string | undefined {
  const baseLines = splitLines(base);
  const currentLines = splitLines(current);
  // Line i of `current` is line map[i] of `base`, or null where they differ.
  const map: Array<number | null> = [];
  let b = 0;
  for (const op of diffLines(currentLines, baseLines)) {
    if (op.type === 'equal') map.push(b++);
    else if (op.type === 'delete') map.push(null);
    else b++;
  }
  // Before the first line and after the last one, the files' starts and ends match up.
  const at = (i: number) => (i < 0 ? -1 : i >= map.length ? baseLines.length : map[i]);
  // Changed blocks of current -> next: lines [start, end) of `current` replaced by `lines`.
  const blocks: Array<{ start: number; end: number; lines: string[] }> = [];
  let line = 0;
  for (const op of diffLines(currentLines, splitLines(next))) {
    if (op.type === 'equal') {
      line++;
      continue;
    }
    let block = blocks.at(-1);
    if (!block || block.end !== line) blocks.push((block = { start: line, end: line, lines: [] }));
    if (op.type === 'delete') block.end = ++line;
    else block.lines.push(op.line);
  }
  const out = [...baseLines];
  for (const { start, end, lines } of blocks.reverse()) {
    for (let i = start - 1; i < end; i++) {
      const here = at(i);
      if (here === null || at(i + 1) !== here + 1) return undefined;
    }
    out.splice(at(start - 1)! + 1, end - start, ...lines);
  }
  return out.join('');
}
