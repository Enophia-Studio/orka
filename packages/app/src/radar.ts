import {
  type AIProvider,
  getLocale,
  type HostPacer,
  mergeReports,
  proposalSpec,
  Radar,
  type RadarCluster,
  type RadarItem,
  radarLinkTarget,
  type RadarReport,
  type RadarStage,
  type RadarStatus,
  t,
  validateReport,
} from '@orka/core';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { RadarClusterView, RadarItemView, RadarReportView, RadarView, ToWebview } from './protocol';
import { RadarLock } from './radarLock';
import type { AppSettings } from './settings';

/** The first poll after the app starts waits this long, so the window opens first. */
const START_DELAY_MS = 30_000;
/** Then Radar looks every hour; each source is fetched only as often as its own interval allows. */
const POLL_INTERVAL_MS = 60 * 60 * 1000;
/** While another window runs Radar, this one looks this often for a new report (and whether that window quit). */
const FOLLOW_INTERVAL_MS = 60_000;
/** One analysis reads at most this many entries with at most this many model calls (the core's caps, shown in the panel). */
const MAX_ENTRIES = 40;
const MAX_CALLS = 100;
/** Changes outside the clusters that the panel lists. */
const MAX_OTHERS = 60;
/** A saved report larger than this is not read. */
const MAX_REPORT_BYTES = 16_000_000;

export interface RadarTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: RadarTimers = {
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What tests replace: the network, the clock, the timers and the feeds. */
export interface RadarHooks {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timers?: RadarTimers;
  /** Default: the core's "AI coding tools" preset. */
  sources?: readonly unknown[];
  pacer?: HostPacer;
}

export type RadarModel = { provider: string; model: string; label: string; inherited: boolean } | { problem: string };

/** What Radar needs from the controller it runs in. */
export interface RadarHost {
  post(message: ToWebview): void;
  /** The model an analysis would run on, or why there is none. */
  model(): RadarModel;
  createProvider(ref: string, model: string): AIProvider;
  /** A new task in the current folder with `text` in the message box, never sent. */
  startSession(text: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
}

interface Analysis {
  abort: AbortController;
  stage: RadarStage;
  done: number;
  total: number;
  calls: number;
}

/**
 * The desktop app's Radar. While the user has it on, it polls the public release notes of other AI
 * coding tools (never a model call); when they click Analyze (or with radar.autoAnalyze, after a
 * poll found something), it analyzes the new entries with the user's own provider and keeps one
 * merged report. Its files live in <orka home>/radar: the engine's state.json and report.json, and
 * the lock that lets one Orka window at a time poll and analyze while the others only read.
 */
export class RadarController {
  private readonly radar: Radar;
  private readonly timers: RadarTimers;
  private readonly reportFile: string;
  private readonly lock: RadarLock;
  private timer?: unknown;
  private poller?: AbortController;
  private analysis?: Analysis;
  private report?: RadarReport;
  private status: RadarStatus = { pending: 0, quarantined: 0, sources: [] };
  /** A problem to show in the panel until the next poll or analysis. */
  private error?: string;
  /** Another Orka window holds Radar's lock: it polls and analyzes, this one shows what it writes. */
  private elsewhere = false;
  /** report.json's time and size when this window last read or wrote it, to notice another window's report. */
  private reportStamp?: string;
  private disposed = false;

  constructor(
    private readonly dir: string,
    private settings: AppSettings['radar'],
    private readonly host: RadarHost,
    private readonly hooks: RadarHooks = {},
  ) {
    // Nothing is read or fetched here: the engine reads its state file when it is used.
    this.radar = new Radar({ statePath: path.join(dir, 'state.json'), sources: hooks.sources, fetchImpl: hooks.fetchImpl, now: hooks.now, pacer: hooks.pacer });
    this.reportFile = path.join(dir, 'report.json');
    this.lock = new RadarLock(path.join(dir, 'lock'));
    this.timers = hooks.timers ?? NODE_TIMERS;
  }

  /** Read the saved report and state (local files only), and plan the first poll when Radar is on (and this window owns it). */
  async initialize(): Promise<void> {
    if (this.settings.enabled) await this.claim();
    this.report = await this.readReport();
    this.status = await this.radar.status().catch(() => this.status);
    this.postState();
    this.postReport();
    if (this.settings.enabled) this.schedule(this.elsewhere ? FOLLOW_INTERVAL_MS : START_DELAY_MS);
  }

  /** The settings were read again: turning Radar on checks the feeds right away, turning it off stops everything. */
  apply(settings: AppSettings['radar']): void {
    const was = this.settings.enabled;
    this.settings = settings;
    if (settings.enabled && !was) void this.follow();
    else if (!settings.enabled && was) this.stop();
    this.postState();
  }

  postAll(): void {
    this.postState();
    this.postReport();
    // The panel opened: what the window that runs Radar wrote meanwhile shows without waiting for the next look.
    if (this.elsewhere) void this.follow();
  }

  postState(): void {
    if (!this.disposed) this.host.post({ type: 'radar', radar: this.view() });
  }

  private postReport(): void {
    if (!this.disposed) this.host.post({ type: 'radarReport', report: this.reportView() });
  }

  // ---------------------------------------------------------------- polling (no model calls)

  private schedule(ms: number): void {
    this.clearTimer();
    if (!this.settings.enabled || this.disposed) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void (this.elsewhere ? this.follow() : this.poll());
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  /** Check the sources that are due (each one keeps its own minimum interval) and queue new entries. */
  async poll(): Promise<void> {
    if (!this.settings.enabled || this.poller || this.disposed) return;
    const abort = new AbortController();
    this.poller = abort;
    this.error = undefined;
    // Only the window that holds Radar's lock polls; any other one shows what that one finds.
    if (!(await this.claim())) {
      this.poller = undefined;
      this.releaseWhenIdle();
      await this.follow();
      return;
    }
    this.postState();
    // The saved report could not be read at start (busy for a moment): it is tried again with each check.
    if (!this.report) await this.reloadReport();
    let found = 0;
    try {
      found = (await this.radar.poll({ signal: abort.signal })).newEntries.length;
    } catch (error) {
      if (!abort.signal.aborted) this.error = t('Radar could not check the feeds: {error}', { error: messageOf(error) });
    } finally {
      if (this.poller === abort) this.poller = undefined;
    }
    await this.refresh();
    // Turned off meanwhile: nothing more is planned.
    if (abort.signal.aborted || !this.settings.enabled || this.disposed) return;
    this.schedule(POLL_INTERVAL_MS);
    if (found > 0 && this.settings.autoAnalyze && !('problem' in this.host.model())) void this.analyze();
  }

  /** Turned off: no timer, and whatever runs is stopped; the lock goes once it has (see refresh). */
  private stop(): void {
    this.clearTimer();
    this.poller?.abort();
    this.analysis?.abort.abort();
    this.elsewhere = false;
    this.releaseWhenIdle();
  }

  private async refresh(): Promise<void> {
    this.releaseWhenIdle();
    this.status = await this.radar.status().catch(() => this.status);
    this.postState();
  }

  // ---------------------------------------------------------------- one window at a time

  /** Whether this window may poll and analyze: it holds Radar's lock, taking it when it is free or left over. */
  private async claim(): Promise<boolean> {
    if (!this.settings.enabled || this.disposed) return false;
    let held: boolean;
    try {
      held = await this.lock.acquire();
    } catch {
      // The folder cannot be written (read-only, full): no lock, and the poll will say what is wrong.
      held = true;
    }
    // Turned off (or closed) while it looked.
    if (!this.settings.enabled || this.disposed) {
      this.releaseWhenIdle();
      return false;
    }
    if (this.elsewhere === held) {
      this.elsewhere = !held;
      this.postState();
    }
    return held;
  }

  /**
   * Radar is on and another window may run it: take over when its lock is free (that window quit or
   * turned it off) and poll now, otherwise show what that window wrote and look again in a minute.
   */
  private async follow(): Promise<void> {
    const owner = await this.claim();
    if (!this.settings.enabled || this.disposed) return;
    await this.reloadReport();
    if (owner) {
      this.schedule(0);
      return;
    }
    await this.refresh();
    this.schedule(FOLLOW_INTERVAL_MS);
  }

  /** Off and idle: the lock goes, so another window can run Radar. An aborted analysis still writes its results first. */
  private releaseWhenIdle(): void {
    if ((!this.settings.enabled || this.disposed) && !this.poller && !this.analysis) this.lock.release();
  }

  // ---------------------------------------------------------------- analysis (model calls, on request)

  /** Analyze what is waiting with the model the panel shows; one analysis at a time. */
  async analyze(): Promise<void> {
    if (!this.settings.enabled || this.analysis || this.disposed) return;
    // Only the window that holds Radar's lock analyzes: another one would pay for the same entries again.
    if (!(await this.claim())) return this.follow();
    if (!this.settings.enabled || this.analysis || this.disposed) return;
    const choice = this.host.model();
    if ('problem' in choice) {
      this.error = choice.problem;
      this.postState();
      return;
    }
    let provider: AIProvider;
    try {
      provider = this.host.createProvider(choice.provider, choice.model);
    } catch (error) {
      this.error = messageOf(error);
      this.postState();
      return;
    }
    const run: Analysis = { abort: new AbortController(), stage: 'summarize', done: 0, total: 0, calls: 0 };
    this.analysis = run;
    this.error = undefined;
    this.postState();
    // Counts the calls as they go out, for the panel; the report's count is the final one.
    const counted: AIProvider = {
      id: provider.id,
      label: provider.label,
      model: provider.model,
      chat: (request, onEvent) => {
        run.calls++;
        this.postState();
        return provider.chat(request, onEvent);
      },
    };
    try {
      const report = await this.radar.analyze(counted, {
        previous: this.report,
        maxEntries: MAX_ENTRIES,
        maxCalls: MAX_CALLS,
        signal: run.abort.signal,
        language: getLocale(),
        onProgress: (p) => {
          Object.assign(run, { stage: p.stage, done: p.done, total: p.total });
          this.postState();
        },
        // Saved before the engine takes the entries off its queue: a failed save loses nothing.
        save: (next) => this.saveReport(next),
      });
      if (report) {
        if (report.stats.stopped === 'error') this.error = t('The analysis stopped: {error}', { error: report.stats.error ?? '?' });
        this.postReport();
      }
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      provider.dispose?.();
      this.analysis = undefined;
      await this.refresh();
    }
  }

  stopAnalysis(): void {
    this.analysis?.abort.abort();
  }

  /** Put the entries the model could not read back in the queue (after a provider or model change). */
  async retry(): Promise<void> {
    // The queue belongs to the window that runs Radar.
    if (!(await this.claim())) return this.follow();
    await this.radar.retryQuarantined();
    await this.refresh();
  }

  /**
   * The text for a session that implements a proposal: the validated spec of the cluster in the
   * report, never anything from the page or the release notes.
   */
  async startSession(clusterKey: string): Promise<void> {
    const cluster = this.report?.clusters.find((c) => c.key === clusterKey);
    const spec = cluster?.decision ? proposalSpec(cluster.decision, cluster) : undefined;
    if (spec) await this.host.startSession(spec);
  }

  /** Open a release note: only an https link that is in the report, checked the way the report renderer checks it. */
  async openLink(url: string): Promise<void> {
    const target = radarLinkTarget(url);
    if (!target || !this.report?.items.some((i) => radarLinkTarget(i.url) === target)) return;
    await this.host.openExternal(target);
  }

  /** The app quits: everything stops and the lock goes now (the process exits right after). */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.lock.release();
  }

  // ---------------------------------------------------------------- the report file

  /** The saved report, checked field by field; a file that fails the checks is moved aside and never used. */
  private async readReport(): Promise<RadarReport | undefined> {
    let raw = '';
    let stamp: string | undefined;
    try {
      const { stat, text } = await readCapped(this.reportFile, MAX_REPORT_BYTES);
      // A file too large to be a report is set aside like a broken one.
      if (text !== undefined) {
        raw = text;
        stamp = stampOf(stat);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // Busy or locked for a moment (a scanner, a backup): the file stays where it is and is read again later.
      this.error = t('The saved Radar report could not be read right now: {error}', { error: messageOf(error) });
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const { report } = validateReport(value);
    if (report) {
      this.reportStamp = stamp;
      return report;
    }
    const aside = path.join(this.dir, `report.broken-${Date.now()}.json`);
    await fs.rename(this.reportFile, aside).catch(() => undefined);
    this.error = t('The saved Radar report could not be read and was set aside ({file}).', { file: path.basename(aside) });
    return undefined;
  }

  /**
   * The report file now: unchanged since this window last read or wrote it, missing, or a report
   * another window wrote. Throws when it cannot be read or fails its checks.
   */
  private async diskReport(): Promise<{ report: RadarReport; stamp: string } | 'unchanged' | 'missing'> {
    let read: { stat: Stats; text?: string };
    try {
      read = await readCapped(this.reportFile, MAX_REPORT_BYTES, this.reportStamp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
    const stamp = stampOf(read.stat);
    if (stamp === this.reportStamp) return 'unchanged';
    const { report } = read.text === undefined ? {} : validateReport(JSON.parse(read.text));
    if (!report) throw new Error(t('The saved Radar report does not pass its checks.'));
    return { report, stamp };
  }

  /** Show the report the window that runs Radar wrote, once the file changed (a file that does not read well is tried again later). */
  private async reloadReport(): Promise<void> {
    const changed = await this.diskReport().catch(() => undefined);
    if (typeof changed !== 'object' || this.disposed) return;
    this.report = changed.report;
    this.reportStamp = changed.stamp;
    this.postReport();
  }

  /**
   * Add a run's report to the saved one and make the result this window's. When that fails, nothing
   * changes (and no temp file stays), and the engine keeps the entries queued.
   */
  private async saveReport(report: RadarReport): Promise<void> {
    // Another window wrote the file since this one read it (it ran Radar until it quit, or took over a
    // lock that looked left over): the run goes on top of that report. A file that cannot be read is
    // never written over: the save fails and is tried again with the next analysis.
    const onDisk = await this.diskReport();
    const next = mergeReports(typeof onDisk === 'object' ? onDisk.report : this.report, report);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.reportFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(next)}\n`, 'utf8');
      // Windows refuses to replace a file a scanner has open for a moment: try a few times.
      for (let attempt = 1; ; attempt++) {
        try {
          await fs.rename(tmp, this.reportFile);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 8 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
        }
      }
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.report = next;
    this.reportStamp = await fs.stat(this.reportFile).then(stampOf, () => undefined);
  }

  // ---------------------------------------------------------------- views

  private view(): RadarView {
    const enabled = this.radar.sources.filter((s) => s.enabled);
    const polled = new Map(this.status.sources.map((s) => [s.id, s]));
    const hosts = new Map<string, string[]>();
    for (const source of enabled) {
      for (const host of source.allowHosts) hosts.set(host, [...new Set([...(hosts.get(host) ?? []), source.product])]);
    }
    const last = this.status.sources.map((s) => s.lastPolledAt ?? '').sort().at(-1);
    const model = this.host.model();
    const run = this.analysis;
    return {
      enabled: this.settings.enabled,
      autoAnalyze: this.settings.autoAnalyze,
      hosts: [...hosts].map(([host, products]) => ({ host, products })),
      sources: enabled.map((s) => {
        const state = polled.get(s.id);
        return {
          id: s.id,
          vendor: s.vendor,
          product: s.product,
          host: new URL(s.url).hostname,
          ...(state?.lastPolledAt ? { lastPolledAt: state.lastPolledAt } : {}),
          ...(state?.lastStatus ? { lastStatus: state.lastStatus } : {}),
          ...(state?.lastError ? { lastError: state.lastError } : {}),
        };
      }),
      sourceErrors: [...this.radar.sourceErrors],
      polling: !!this.poller,
      ...(last ? { lastPollAt: last } : {}),
      pending: this.status.pending,
      quarantined: this.status.quarantined,
      choice: { provider: this.settings.provider, model: this.settings.model },
      maxCalls: MAX_CALLS,
      ...('problem' in model ? { modelProblem: model.problem } : { model }),
      ...(run ? { analysis: { stage: run.stage, done: run.done, total: run.total, calls: run.calls, maxCalls: MAX_CALLS } } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.elsewhere && this.settings.enabled ? { elsewhere: true } : {}),
    };
  }

  private reportView(): RadarReportView | undefined {
    const report = this.report;
    if (!report) return undefined;
    const items = new Map(report.items.map((i) => [i.id, i]));
    const clustered = new Set(report.clusters.flatMap((c) => c.itemIds));
    const clusters: RadarClusterView[] = [...report.clusters]
      .sort((a, b) => rank(a) - rank(b) || b.relevance - a.relevance)
      .map((c) => ({
        key: c.key,
        title: c.title,
        vendors: c.vendors,
        tags: c.tags,
        items: c.itemIds.flatMap((id) => (items.has(id) ? [itemView(items.get(id)!)] : [])),
        ...(c.comparison ? { comparison: c.comparison } : {}),
        ...(c.decision ? { decision: c.decision } : {}),
        canStart: !!c.decision && proposalSpec(c.decision, c) !== undefined,
      }));
    const others = report.items
      .filter((i) => !clustered.has(i.id) && i.relevance > 0)
      .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
      .slice(0, MAX_OTHERS)
      .map(itemView);
    return { generatedAt: report.generatedAt, provider: report.provider, clusters, others, needsHuman: report.needsHuman.length, stats: report.stats };
  }
}

/** What Orka lacks first (P1 to P3), then what is not decided, then what Orka has, then what it does not want. */
function rank(cluster: RadarCluster): number {
  const d = cluster.decision;
  if (!d) return 3;
  if (d.decision === 'gap') return Number(d.priority[1]) - 1;
  return d.decision === 'already_have' ? 4 : 5;
}

function itemView(item: RadarItem): RadarItemView {
  const url = radarLinkTarget(item.url);
  return {
    id: item.id,
    vendor: item.vendor,
    product: item.product,
    title: item.title,
    summary: item.summary,
    kind: item.kind,
    relevance: item.relevance,
    ...(item.match ? { match: item.match } : {}),
    ...(url ? { url } : {}),
    ...(item.published ? { published: item.published } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A file's time and size: another value means another write. */
function stampOf(stat: { mtimeMs: number; size: number }): string {
  return `${stat.mtimeMs}:${stat.size}`;
}

/**
 * A file's stat and, when it is at most `max` bytes (and its stamp is not `unchanged`), its text:
 * both from one open handle, so they belong to the same file.
 */
async function readCapped(file: string, max: number, unchanged?: string): Promise<{ stat: Stats; text?: string }> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > max || stampOf(stat) === unchanged) return { stat };
    return { stat, text: await handle.readFile('utf8') };
  } finally {
    await handle.close();
  }
}
