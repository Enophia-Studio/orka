import { t } from '../i18n';
import type { AIProvider } from '../providers/AIProvider';
import { HostPacer } from './fetch';
import { BUILTIN_INVENTORY, type FeatureInventory } from './inventory';
import { analyzeEntries, pollSources, type RadarAnalyzeOptions, type RadarPollResult } from './pipeline';
import { defaultSources, validateSources } from './sources';
import { loadRadarState, pruneSources, QUARANTINE_CAP, queue, RADAR_ENTRY_FAILURES, type RadarPollStatus, saveRadarState } from './state';
import type { RadarReport, RadarSource } from './types';

export interface RadarOptions {
  /** The JSON state file (seen ids, body hashes, pending entries and what was summarized of them). Created on first use. */
  statePath: string;
  /** Default: the "AI coding tools" preset. Checked with validateSources; invalid ones are left out (see `sourceErrors`). */
  sources?: readonly unknown[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Shared spacing between requests to one host; one per radar by default. */
  pacer?: HostPacer;
  /** Per request, default 30 s. */
  timeoutMs?: number;
}

export interface RadarRunOptions extends RadarAnalyzeOptions {
  inventory?: FeatureInventory;
  /**
   * Keeps the run's report (the desktop app merges it into its report file). Awaited before any
   * entry leaves the queue: when it throws, the queue stays as it was and analyze() rethrows, so a
   * report that could not be kept is never lost with its entries.
   */
  save?: (report: RadarReport) => Promise<void>;
}

export interface RadarSourceStatus {
  id: string;
  vendor: string;
  product: string;
  enabled: boolean;
  lastPolledAt?: string;
  lastStatus?: RadarPollStatus;
  lastError?: string;
  /** Set once the first poll succeeded. */
  baselineAt?: string;
}

export interface RadarStatus {
  /** Entries waiting for analysis: a non-zero count means there is something to wake up for. */
  pending: number;
  quarantined: number;
  sources: RadarSourceStatus[];
}

/**
 * The radar's API for the apps. `poll()` checks the feeds (no model calls) and queues new
 * entries; `analyze()` wakes up only when something is queued and returns a report. State is a
 * JSON file the caller chooses; reports are returned and kept by the caller (mergeReports joins
 * them for a panel). Safe to call from timers: calls on one instance are serialized.
 */
export class Radar {
  /** The valid sources, normalized. */
  readonly sources: readonly RadarSource[];
  /** Why sources were left out (for the user, translated). */
  readonly sourceErrors: readonly string[];
  private readonly pacer: HostPacer;
  private lock: Promise<unknown> = Promise.resolve();
  private analyzing = false;

  constructor(private readonly options: RadarOptions) {
    // Checked here too: the patterns run on feed text and the hosts decide what gets fetched.
    const checked = validateSources(options.sources ?? defaultSources());
    this.sources = checked.sources;
    this.sourceErrors = checked.errors;
    this.pacer = options.pacer ?? new HostPacer();
  }

  /** Check every source that is due (or all with `force`) and queue new entries. Never calls a model. */
  poll(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<RadarPollResult> {
    return this.exclusive(async () => {
      const state = await loadRadarState(this.options.statePath);
      pruneSources(
        state,
        this.sources.map((s) => s.id),
      );
      const result = await pollSources(this.sources, state, {
        fetchImpl: this.options.fetchImpl,
        pacer: this.pacer,
        signal: opts.signal,
        timeoutMs: this.options.timeoutMs,
        force: opts.force,
        now: this.now(),
      });
      await saveRadarState(this.options.statePath, state);
      return result;
    });
  }

  /**
   * Analyze queued entries with `provider` (the user's own API provider, or Claude Code as a plain
   * model; every call has no tools). Returns undefined without any model call when nothing is queued. An entry leaves
   * the queue once its relevant items reached a decision; the rest stay queued (with what was
   * already summarized of them, so the next run goes on from there), and entries the model failed
   * on twice are quarantined.
   */
  async analyze(provider: AIProvider, opts: RadarRunOptions = {}): Promise<RadarReport | undefined> {
    if (this.analyzing) throw new Error(t('The radar is already analyzing new entries.'));
    this.analyzing = true;
    try {
      const { pending, summarized } = await this.exclusive(() => loadRadarState(this.options.statePath));
      if (pending.length === 0) return undefined;
      const { inventory, save, ...rest } = opts;
      const result = await analyzeEntries(pending, provider, inventory ?? BUILTIN_INVENTORY, { ...rest, sources: this.sources, now: opts.now ?? this.options.now, summarized });
      // The report is kept first: if that fails, nothing leaves the queue.
      await save?.(result.report);
      await this.exclusive(async () => {
        // Read again: a poll may have queued more entries meanwhile.
        const state = await loadRadarState(this.options.statePath);
        const done = new Set(result.processed);
        state.pending = state.pending.filter((e) => !done.has(e.id));
        const waiting = new Set(state.pending.map((e) => e.id));
        for (const id of Object.keys(state.summarized)) if (!waiting.has(id)) delete state.summarized[id];
        for (const [id, items] of Object.entries(result.unfinished)) if (waiting.has(id)) state.summarized[id] = items;
        const at = this.now().toISOString();
        state.quarantine.push(...result.quarantined.map((q) => ({ ...q, at })));
        // An entry the provider keeps failing on (while it answers others) must not hold up the queue:
        // it goes to the back, and after RADAR_ENTRY_FAILURES runs it is set aside for a retry by hand.
        for (const id of Object.keys(state.failures)) if (!waiting.has(id)) delete state.failures[id];
        for (const id of result.failed) {
          const index = state.pending.findIndex((e) => e.id === id);
          if (index < 0) continue;
          const [entry] = state.pending.splice(index, 1);
          const count = (state.failures[id] ?? 0) + 1;
          if (count >= RADAR_ENTRY_FAILURES) {
            delete state.failures[id];
            delete state.summarized[id];
            state.quarantine.push({ entry, stage: 'summarize', reason: `The provider failed on this entry in ${count} runs: ${result.report.stats.error ?? '?'}`.slice(0, 1_000), at });
          } else {
            state.failures[id] = count;
            state.pending.push(entry);
          }
        }
        if (state.quarantine.length > QUARANTINE_CAP) state.quarantine.splice(0, state.quarantine.length - QUARANTINE_CAP);
        await saveRadarState(this.options.statePath, state);
      });
      return result.report;
    } finally {
      this.analyzing = false;
    }
  }

  /** Per-source poll state and the queue sizes, for a status line. */
  status(): Promise<RadarStatus> {
    return this.exclusive(async () => {
      const state = await loadRadarState(this.options.statePath);
      return {
        pending: state.pending.length,
        quarantined: state.quarantine.length,
        sources: this.sources.map((source) => {
          const s = state.sources[source.id]?.url === source.url ? state.sources[source.id] : undefined;
          return {
            id: source.id,
            vendor: source.vendor,
            product: source.product,
            enabled: source.enabled,
            ...(s?.lastPolledAt ? { lastPolledAt: s.lastPolledAt } : {}),
            ...(s?.lastStatus ? { lastStatus: s.lastStatus } : {}),
            ...(s?.lastError ? { lastError: s.lastError } : {}),
            ...(s?.baselineAt ? { baselineAt: s.baselineAt } : {}),
          };
        }),
      };
    });
  }

  /** Put quarantined entries back in the queue (after a provider or model change). Returns how many. */
  retryQuarantined(): Promise<number> {
    return this.exclusive(async () => {
      const state = await loadRadarState(this.options.statePath);
      const entries = state.quarantine.map((q) => q.entry);
      state.quarantine = [];
      const added = queue(state, entries);
      await saveRadarState(this.options.statePath, state);
      return added.length;
    });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.catch(() => {});
    return next;
  }
}
