import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ENTRY_TEXT_MAX } from './feeds';
import { validateItem } from './report';
import { RADAR_STAGES, type RadarEntry, type RadarItem, type RadarStage } from './types';
import { LIMITS } from './validate';

/** Entry ids remembered per source. More than a feed lists (200), so a listed entry is never new twice. */
export const SEEN_CAP = 300;
/** Entries waiting for analysis; beyond this the oldest are dropped. */
export const PENDING_CAP = 200;
export const QUARANTINE_CAP = 100;
/** New entries one source can queue per poll (a feed that suddenly lists 200 "new" entries is not news). */
const NEW_PER_POLL = 50;
/** The first poll of a source only queues entries from the last two weeks. */
const BASELINE_DAYS = 14;
/** ...and, of undated entries (a CHANGELOG.md without dates), only the newest. */
const BASELINE_UNDATED = 1;

export type RadarPollStatus = 'baseline' | 'new' | 'unchanged' | 'not_modified' | 'error';

export interface RadarSourceState {
  /** The URL the state below belongs to; a changed URL starts the source over. */
  url: string;
  /** sha256 of the last body read (and how it was read): the same body again is not parsed. Made here, sent nowhere. */
  bodyHash?: string;
  lastPolledAt?: string;
  lastStatus?: RadarPollStatus;
  lastError?: string;
  /** When the first successful poll happened. */
  baselineAt?: string;
  /** Newest first. */
  seen: string[];
}

export interface RadarQuarantined {
  entry: RadarEntry;
  stage: RadarStage;
  reason: string;
  at: string;
}

export interface RadarState {
  version: 1;
  sources: Record<string, RadarSourceState>;
  pending: RadarEntry[];
  /**
   * By entry id, for pending entries an analysis already summarized: their relevant items that
   * have not reached a decision yet. The next analysis continues with them instead of paying for
   * the summaries again.
   */
  summarized: Record<string, RadarItem[]>;
  /** Entries the model could not summarize validly twice (needs_human). */
  quarantine: RadarQuarantined[];
  /** By entry id, the runs in which the provider failed on that pending entry alone (see RADAR_ENTRY_FAILURES). */
  failures: Record<string, number>;
}

/** After this many runs in which the provider failed on an entry while answering others, the entry is quarantined. */
export const RADAR_ENTRY_FAILURES = 2;

export function emptyRadarState(): RadarState {
  return { version: 1, sources: {}, pending: [], summarized: {}, quarantine: [], failures: {} };
}

/**
 * The state at `file`. Only a missing file is a fresh state (the next poll is a baseline). Any
 * other read error is thrown, so the poll or analysis fails and is tried again later instead of
 * saving a fresh state over a good one; a file that is not a JSON object is moved aside
 * (state.broken-<time>.json) before starting over.
 */
export async function loadRadarState(file: string): Promise<RadarState> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRadarState();
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    raw = undefined;
  }
  const state = emptyRadarState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // When it cannot be moved, this throws: nothing is saved over it either.
    await fs.rename(file, path.join(path.dirname(file), `${path.basename(file, '.json')}.broken-${Date.now()}.json`));
    return state;
  }
  const r = raw as Record<string, unknown>;
  if (r.sources && typeof r.sources === 'object') {
    for (const [id, value] of Object.entries(r.sources as Record<string, unknown>)) {
      const source = sourceState(value);
      if (/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) && source) state.sources[id] = source;
    }
  }
  if (Array.isArray(r.pending)) state.pending = r.pending.map(entry).filter((e): e is RadarEntry => !!e).slice(-PENDING_CAP);
  if (r.summarized && typeof r.summarized === 'object') {
    // Only for entries still waiting, and checked like the items of a stored report.
    const waiting = new Set(state.pending.map((e) => e.id));
    for (const [id, list] of Object.entries(r.summarized as Record<string, unknown>)) {
      if (!waiting.has(id) || !Array.isArray(list)) continue;
      const items = list
        .slice(0, LIMITS.itemsPerEntry)
        .map(validateItem)
        .filter((i): i is RadarItem => i?.entryId === id);
      if (items.length) state.summarized[id] = items;
    }
  }
  if (r.failures && typeof r.failures === 'object') {
    const waiting = new Set(state.pending.map((e) => e.id));
    for (const [id, count] of Object.entries(r.failures as Record<string, unknown>)) {
      if (waiting.has(id) && Number.isInteger(count) && (count as number) > 0 && (count as number) < RADAR_ENTRY_FAILURES) state.failures[id] = count as number;
    }
  }
  if (Array.isArray(r.quarantine)) {
    for (const q of r.quarantine.slice(-QUARANTINE_CAP)) {
      const item = q as Partial<RadarQuarantined> | null;
      const e = entry(item?.entry);
      if (e && RADAR_STAGES.includes(item!.stage as RadarStage) && typeof item!.reason === 'string' && typeof item!.at === 'string')
        state.quarantine.push({ entry: e, stage: item!.stage as RadarStage, reason: item!.reason.slice(0, 1_000), at: item!.at.slice(0, 40) });
    }
  }
  return state;
}

/** Write the state atomically: a crash or a second writer never leaves half a file. */
export async function saveRadarState(file: string, state: RadarState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state));
}

/** Write `text` to `file` through a temp file and a rename (its folder is created): never half a file. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      // Windows refuses the rename while another process (a virus scanner, a second Orka) has the file open.
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** The state of one source, started over when its URL changed. */
export function sourceStateFor(state: RadarState, sourceId: string, url: string): RadarSourceState {
  // Source ids are checked when the list is loaded; this keeps a bad one off Object.prototype regardless.
  if (sourceId === '__proto__' || sourceId === 'constructor' || sourceId === 'prototype') throw new Error(`Invalid source id: ${sourceId}`);
  const current = state.sources[sourceId];
  if (current && current.url === url) return current;
  return (state.sources[sourceId] = { url, seen: [] });
}

/**
 * Record the entries a source lists now and queue the new ones. The first time, everything is
 * a baseline: only entries from the last 14 days (and the newest undated one) are queued.
 * Returns the queued entries.
 */
export function recordEntries(state: RadarState, source: RadarSourceState, entries: RadarEntry[], now: Date): { fresh: RadarEntry[]; baseline: boolean } {
  const baseline = !source.baselineAt;
  // A first answer without entries (an error page, a filter that matches nothing yet) is no
  // baseline: the first real list would otherwise all count as new.
  if (baseline && entries.length === 0) return { fresh: [], baseline };
  let fresh: RadarEntry[];
  if (baseline) {
    const cutoff = now.getTime() - BASELINE_DAYS * 86_400_000;
    let undated = 0;
    fresh = entries.filter((e) => (e.published ? Date.parse(e.published) >= cutoff : undated++ < BASELINE_UNDATED));
    source.baselineAt = now.toISOString();
  } else {
    const seen = new Set(source.seen);
    fresh = entries.filter((e) => !seen.has(e.id));
  }
  // Everything the feed lists now stays remembered; older ids fill the rest of the cap.
  const listed = new Set(entries.map((e) => e.id));
  source.seen = [...listed, ...source.seen.filter((id) => !listed.has(id))].slice(0, SEEN_CAP);
  fresh = queue(state, fresh.slice(0, NEW_PER_POLL));
  return { fresh, baseline };
}

/** Add entries to the pending queue (skipping ones already waiting or quarantined). */
export function queue(state: RadarState, entries: RadarEntry[]): RadarEntry[] {
  const known = new Set([...state.pending.map((e) => e.id), ...state.quarantine.map((q) => q.entry.id)]);
  const added = entries.filter((e) => !known.has(e.id) && known.add(e.id));
  state.pending.push(...added);
  for (const dropped of state.pending.splice(0, Math.max(0, state.pending.length - PENDING_CAP))) {
    delete state.summarized[dropped.id];
    delete state.failures[dropped.id];
  }
  return added;
}

/** Forget sources that are no longer in the list. */
export function pruneSources(state: RadarState, ids: Iterable<string>): void {
  const keep = new Set(ids);
  for (const id of Object.keys(state.sources)) if (!keep.has(id)) delete state.sources[id];
}

const str = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

function sourceState(value: unknown): RadarSourceState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!str(v.url, 500) || !Array.isArray(v.seen)) return undefined;
  const statuses: RadarPollStatus[] = ['baseline', 'new', 'unchanged', 'not_modified', 'error'];
  // The ETag and Last-Modified values an earlier version kept here are not read: nothing a server issued is sent back to it.
  return {
    url: v.url,
    ...(str(v.bodyHash, 64) && /^[0-9a-f]{64}$/.test(v.bodyHash) ? { bodyHash: v.bodyHash } : {}),
    ...(str(v.lastPolledAt, 40) ? { lastPolledAt: v.lastPolledAt } : {}),
    ...(statuses.includes(v.lastStatus as RadarPollStatus) ? { lastStatus: v.lastStatus as RadarPollStatus } : {}),
    ...(str(v.lastError, 500) ? { lastError: v.lastError } : {}),
    ...(str(v.baselineAt, 40) ? { baselineAt: v.baselineAt } : {}),
    seen: v.seen.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)).slice(0, SEEN_CAP),
  };
}

/** A stored entry, checked field by field (the file can be edited by hand). */
function entry(value: unknown): RadarEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!str(v.id, 64) || !/^[0-9a-f]{64}$/.test(v.id) || !str(v.sourceId, 48) || !str(v.vendor, 40) || !str(v.product, 60)) return undefined;
  if (!str(v.title, 200) || !str(v.text, ENTRY_TEXT_MAX)) return undefined;
  const url = str(v.url, 1_000) && v.url.startsWith('https://') ? v.url : undefined;
  const published = str(v.published, 40) && Number.isFinite(Date.parse(v.published)) ? v.published : undefined;
  return {
    id: v.id,
    sourceId: v.sourceId,
    vendor: v.vendor,
    product: v.product,
    title: v.title,
    ...(str(v.tag, 100) ? { tag: v.tag } : {}),
    ...(url ? { url } : {}),
    ...(published ? { published } : {}),
    text: v.text,
  };
}
