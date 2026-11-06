import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { t, tn } from '../i18n';
import { escapeMarkdown, kindLabel, proposalSpec, radarLinkTarget, renderReportMarkdown, stoppedText } from './report';
import { writeFileAtomic } from './state';
import type { RadarCluster, RadarItem, RadarReport } from './types';

/**
 * Markdown notes of what each analysis found, for the user to hand to a coding assistant: one file
 * per run in <orka home>/radar/notes, and LATEST.md with the newest one. Local files only; like the
 * report, they hold summaries and validated proposals, never release-note text.
 */

/** Notes kept; older ones are deleted (only files named like a note). */
export const RADAR_NOTES_KEEP = 50;
/** Always the newest note, so an assistant can be pointed at one fixed path. */
export const RADAR_NOTES_LATEST = 'LATEST.md';
/** radar-YYYY-MM-DD-HHMM.md, with -2, -3 ... for a second run in the same minute. */
const NOTE_NAME = /^radar-(\d{4}-\d{2}-\d{2}-\d{4})(?:-(\d{1,4}))?\.md$/;

/** What a run added to the report it goes on top of. */
export interface RadarNoteDiff {
  /** New clusters, and clusters whose decision is new or changed. */
  clusters: RadarCluster[];
  /** New items about coding tools (relevance above 0). */
  items: RadarItem[];
}

const decisionOf = (c: RadarCluster) => {
  const d = c.decision;
  return d ? JSON.stringify([d.decision, d.priority, d.effort, d.fitsPrinciples, d.proposal?.title ?? '']) : '';
};

/** The clusters and items of `run` that `previous` (the report it is merged on top of) did not have, or decided otherwise. */
export function radarNoteDiff(previous: RadarReport | undefined, run: RadarReport): RadarNoteDiff {
  const known = new Map((previous?.clusters ?? []).map((c) => [c.key, c]));
  const clusters = run.clusters.filter((c) => {
    const before = known.get(c.key);
    // A run that did not decide a known cluster again keeps its earlier decision (mergeReports): no change.
    return !before || (!!c.decision && decisionOf(c) !== decisionOf(before));
  });
  const seen = new Set((previous?.items ?? []).map((i) => i.id));
  return { clusters, items: run.items.filter((i) => i.relevance > 0 && !seen.has(i.id)) };
}

const pad = (n: number, size = 2) => String(n).padStart(size, '0');
/** Local date and time: 2026-11-06 14:30. */
const localStamp = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
const localDate = (at: Date) => localStamp(at).slice(0, 10);

/** A fenced block no line of `text` can close (proposal fields cannot hold ``` anyway): the spec stays copyable as it is. */
function fenced(text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text, fence];
}

/** One note: what is new in `run` (see radarNoteDiff), every value from a feed or a model escaped. */
export function renderRadarNote(run: RadarReport, diff: RadarNoteDiff, at: Date): string {
  const e = escapeMarkdown;
  const gaps = diff.clusters.filter((c) => c.decision?.decision === 'gap');
  const decided = diff.clusters.filter((c) => c.decision && c.decision.decision !== 'gap').length;
  const out: string[] = [`# ${e(t('Radar notes, {date}', { date: localStamp(at) }))}`, ''];
  out.push(
    e(t('Analysis with {provider}.', { provider: `${run.provider.id} / ${run.provider.model}` })),
    '',
    e(
      t('New in this run: {gaps}, {decisions}, {changes}.', {
        gaps: tn('{n} gap', '{n} gaps', gaps.length),
        decisions: tn('{n} other decision', '{n} other decisions', decided),
        changes: tn('{n} new change', '{n} new changes', diff.items.length),
      }),
    ),
    '',
    e(t("Based on public release notes only; summaries and proposals are written by a model and can be wrong. The whole report is in Orka's Radar panel.")),
  );
  if (run.stats.stopped) out.push('', e(stoppedText(run.stats)));
  const priority = (c: RadarCluster) => Number(c.decision!.priority[1]);
  if (gaps.length) {
    out.push('', `## ${e(t('What Orka lacks'))}`);
    for (const c of [...gaps].sort((a, b) => priority(a) - priority(b))) {
      const d = c.decision!;
      out.push('', `### ${e(c.title)}`, '', e(t('Priority {priority}, effort {effort}. Seen at: {vendors}', { priority: d.priority, effort: d.effort, vendors: c.vendors.join(', ') })));
      if (!d.fitsPrinciples) out.push('', e(t("Needs care: it may not fit Orka's rules as it is.")));
      if (d.rationale) out.push('', e(d.rationale));
      // The validated proposal fields and Orka's rules, exactly as "Start a session" puts them in the message box.
      const spec = proposalSpec(d, c);
      if (spec) out.push('', `**${e(t('Proposal for a coding assistant'))}:**`, '', ...fenced(spec));
    }
  }
  const short = (c: RadarCluster) => {
    const why = c.decision?.decidedBy === 'inventory' ? t('Decided from the feature inventory.') : (c.decision?.rationale ?? '');
    return `- **${e(c.title)}** (${c.vendors.map(e).join(', ')})${why ? `: ${e(why)}` : ''}`;
  };
  const section = (title: string, clusters: RadarCluster[]) => {
    if (clusters.length) out.push('', `## ${e(title)}`, '', ...clusters.map(short));
  };
  section(t('Already in Orka'), diff.clusters.filter((c) => c.decision?.decision === 'already_have'));
  section(t('Not for Orka'), diff.clusters.filter((c) => c.decision?.decision === 'not_for_orka'));
  section(t('Not decided yet'), diff.clusters.filter((c) => !c.decision));
  if (diff.items.length) {
    out.push('', `## ${e(t('New changes'))}`);
    for (const vendor of [...new Set(diff.items.map((i) => i.vendor))]) {
      out.push('', `### ${e(vendor)}`, '');
      for (const item of diff.items.filter((i) => i.vendor === vendor)) {
        const href = radarLinkTarget(item.url);
        const title = `${e(item.product)}: ${e(item.title)}`;
        out.push(`- ${href ? `[${title}](<${href}>)` : title}: ${e(item.summary)} _(${e(kindLabel(item.kind))}, ${e(t('relevance {n}', { n: item.relevance }))})_`);
      }
    }
  }
  return `${out.join('\n')}\n`;
}

/** Sort key of a note's file name: its minute, then the number of a second note in that minute. */
function noteKey(name: string): string | undefined {
  const m = NOTE_NAME.exec(name);
  return m ? `${m[1]}-${pad(Number(m[2] ?? 1), 4)}` : undefined;
}

export interface RadarNoteOptions {
  now?: Date;
  /** Default RADAR_NOTES_KEEP. */
  keep?: number;
}

/**
 * Write the note of a run that added or changed something (see radarNoteDiff) to `dir` (created),
 * update LATEST.md, and delete the oldest notes beyond `keep`. Returns the note's path, or
 * undefined when the run brought nothing new. Both files are written atomically.
 */
export async function writeRadarNote(dir: string, previous: RadarReport | undefined, run: RadarReport, options: RadarNoteOptions = {}): Promise<string | undefined> {
  const diff = radarNoteDiff(previous, run);
  if (!diff.clusters.length && !diff.items.length) return undefined;
  const at = options.now ?? new Date();
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const base = `radar-${localStamp(at).replace(' ', '-').replace(':', '')}`;
  let name = `${base}.md`;
  for (let n = 2; names.has(name); n++) name = `${base}-${n}.md`;
  const text = renderRadarNote(run, diff, at);
  const file = path.join(dir, name);
  await writeFileAtomic(file, text);
  await writeFileAtomic(path.join(dir, RADAR_NOTES_LATEST), text);
  // Only files named like a note are ever deleted: anything else in the folder is the user's.
  const notes = [...entries.filter((entry) => entry.isFile()).map((entry) => entry.name), name]
    .flatMap((n) => {
      const key = noteKey(n);
      return key ? [{ name: n, key }] : [];
    })
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  for (const old of notes.slice(Math.max(1, options.keep ?? RADAR_NOTES_KEEP))) {
    await fs.unlink(path.join(dir, old.name)).catch(() => undefined);
  }
  return file;
}

/** The file name "Save as Markdown…" suggests (and uses in the notes folder when there is no save dialog). */
export function radarReportFileName(at: Date = new Date()): string {
  return `radar-report-${localDate(at)}.md`;
}

/** The whole report as Markdown (renderReportMarkdown) in `file`, written atomically; its folder is created. */
export async function writeReportMarkdown(file: string, report: RadarReport): Promise<void> {
  await writeFileAtomic(file, renderReportMarkdown(report));
}
