import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fetchSource, HostPacer, RADAR_USER_AGENT } from '../src/radar/fetch';
import { ENTRY_TEXT_MAX, entryId, parseFeed } from '../src/radar/feeds';
import { Radar } from '../src/radar/Radar';
import { DEFAULT_SOURCES, DEFAULT_STABLE_TAG, NEVER_FETCH_HOSTS, unsafePatternReason, validateSources } from '../src/radar/sources';
import { emptyRadarState, loadRadarState, PENDING_CAP, recordEntries, saveRadarState, SEEN_CAP, sourceStateFor } from '../src/radar/state';
import type { RadarEntry, RadarSource } from '../src/radar/types';
import { VERSION } from '../src/version';
import { tempWorkspace } from './helpers';

const FIXTURES = path.resolve(__dirname, '../../test/fixtures/radar');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

function source(over: Partial<RadarSource> = {}): RadarSource {
  return {
    id: 'agent-cli',
    vendor: 'Example',
    product: 'Agent CLI',
    kind: 'atom',
    url: 'https://github.com/example/agent-cli/releases.atom',
    allowHosts: ['github.com'],
    minIntervalHours: 6,
    maxBytes: 2_000_000,
    enabled: true,
    ...over,
  };
}

function atomEntry(tag: string, updated: string, body = `<p>Notes for ${tag}.</p>`): string {
  const html = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>${updated}</updated><link rel="alternate" href="https://github.com/example/agent-cli/releases/tag/${tag}"/><title>${tag}</title><content type="html">${html}</content></entry>`;
}

describe('Radar sources', () => {
  it('ships a valid preset of public feeds, never openai.com or chatgpt.com', () => {
    const { sources, errors } = validateSources(DEFAULT_SOURCES);
    assert.deepEqual(errors, []);
    assert.equal(sources.length, DEFAULT_SOURCES.length);
    const ids = sources.map((s) => s.id);
    for (const id of ['codex', 'gemini-cli', 'antigravity-cli', 'zed', 'copilot-cli', 'cline', 'kilocode', 'opencode', 'claude-code', 'cursor', 'kiro', 'vscode', 'github-copilot', 'chatgpt-codex'])
      assert.ok(ids.includes(id), id);
    for (const s of sources) {
      const url = new URL(s.url);
      assert.equal(url.protocol, 'https:', s.id);
      assert.ok(!NEVER_FETCH_HOSTS.includes(url.hostname), s.id);
      assert.ok(!s.allowHosts.some((h) => NEVER_FETCH_HOSTS.includes(h)), s.id);
    }
    const byId = new Map(sources.map((s) => [s.id, s]));
    assert.equal(byId.get('claude-code')!.kind, 'markdown');
    assert.equal(byId.get('claude-code')!.url, 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md');
    assert.ok(!sources.some((s) => s.url.includes('anthropics/claude-code/releases')), 'Claude Code is read once, from its changelog');
    assert.equal(byId.get('cursor')!.minIntervalHours, 24);
    assert.equal(byId.get('github-copilot')!.titleFilter, 'copilot');
    assert.equal(byId.get('chatgpt-codex')!.minIntervalHours, 24);
    assert.ok(byId.get('chatgpt-codex')!.maxBytes >= 8_000_000);
    assert.equal(unsafePatternReason(byId.get('codex')!.stable!), undefined);
  });

  it('refuses unsafe or broken sources and keeps the valid ones', () => {
    const cases: Array<Partial<RadarSource> & Record<string, unknown>> = [
      { url: 'http://github.com/example/feed.atom' },
      { url: 'https://127.0.0.1/feed.atom', allowHosts: ['127.0.0.1'] },
      { url: 'https://localhost/feed.atom', allowHosts: ['localhost'] },
      { url: 'https://openai.com/news/rss.xml', allowHosts: ['openai.com'] },
      { url: 'https://chatgpt.com/feed', allowHosts: ['chatgpt.com'] },
      { url: 'https://feeds.example.com/feed.atom' },
      { url: 'https://user:secret@github.com/feed.atom' },
      { url: 'https://github.com:8443/feed.atom' },
      { id: 'Bad Id' },
      { kind: 'html' as RadarSource['kind'] },
      { vendor: '<img src=x>' },
      { stable: '(a+)+$' },
      { titleFilter: '(\\w+)\\1' },
      { maxBytes: 1_000_000_000 },
      { minIntervalHours: 0 },
      { enabled: 'yes' as unknown as boolean },
      { homepage: 'https://elsewhere.example.com/notes' },
    ];
    const { sources, errors } = validateSources([source(), ...cases.map((c, i) => ({ ...source({ id: `bad-${i}` }), ...c }))]);
    assert.deepEqual(
      sources.map((s) => s.id),
      ['agent-cli'],
    );
    assert.equal(errors.length, cases.length, errors.join('\n'));
    assert.match(errors.find((e) => e.includes('bad-3'))!, /openai\.com is never fetched/);

    assert.equal(validateSources([source(), source()]).sources.length, 1, 'a duplicate id is refused');
    assert.equal(validateSources({ sources: [source()] }).sources.length, 1, '{sources: [...]} works too');
    assert.equal(validateSources('nope').errors.length, 1);
    assert.equal(validateSources(Array.from({ length: 60 }, (_, i) => source({ id: `s-${i}` }))).sources.length, 50);
  });

  it('tells safe tag and title patterns from catastrophic ones', () => {
    for (const ok of [DEFAULT_STABLE_TAG, String.raw`^rust-v\d+\.\d+\.\d+$`, 'copilot', String.raw`^(?:v)?\d+(\.\d+)?$`, '[(+*]', '(?<major>\\d+)\\.x'])
      assert.equal(unsafePatternReason(ok), undefined, ok);
    // The two classic catastrophic patterns are put together at run time, so code scanning does not take this test data for a regex in use.
    const classic = [['(a', '+)+$'], ['(a|a', 'a)*b']].map((parts) => parts.join(''));
    for (const bad of [...classic,String.raw`(\d+)*`, '(.*)+', '(?:x+){2,}', '(a)\\1', '(?<n>a)\\k<n>', '[', 'x'.repeat(201)])
      assert.notEqual(unsafePatternReason(bad), undefined, bad);
  });
});

describe('Radar feeds', () => {
  it('reads a GitHub releases feed and keeps stable tags only', () => {
    const entries = parseFeed(source(), fixture('github-releases.atom'));
    assert.deepEqual(
      entries.map((e) => e.tag),
      ['v1.4.0', 'v1.3.2'],
      'nightly, alpha and rc are skipped',
    );
    const [e] = entries;
    const guid = 'tag:github.com,2008:Repository/123456789/v1.4.0';
    assert.equal(e.id, createHash('sha256').update(`agent-cli|${guid}|v1.4.0`).digest('hex'));
    assert.equal(e.id, entryId('agent-cli', guid, 'v1.4.0'));
    assert.equal(e.title, 'v1.4.0 — background agents');
    assert.equal(e.url, 'https://github.com/example/agent-cli/releases/tag/v1.4.0');
    assert.equal(e.published, '2026-10-26T12:30:00.000Z');
    assert.equal(e.vendor, 'Example');
    assert.match(e.text, /^## New features$/m);
    assert.match(e.text, /\*\*background\*\*/);
    assert.match(e.text, /CRLF line endings & tabs/);
    assert.doesNotMatch(e.text, /&lt;|<\/?(p|li|ul)>/);

    // A source that wants pre-releases says so with its own pattern.
    assert.equal(parseFeed(source({ stable: '.' }), fixture('github-releases.atom')).length, 5);
    assert.deepEqual(
      parseFeed(source({ stable: String.raw`^v1\.5\.0-rc\.\d+$` }), fixture('github-releases.atom')).map((x) => x.tag),
      ['v1.5.0-rc.1'],
    );
    // Links to other hosts are dropped.
    assert.equal(parseFeed(source({ allowHosts: ['example.com'] }), fixture('github-releases.atom'))[0].url, undefined);
  });

  it('reads RSS with CDATA and content:encoded, and links only to the source hosts', () => {
    const rss = source({ id: 'editor', kind: 'rss', url: 'https://editor.example.com/changelog/rss.xml', allowHosts: ['editor.example.com'] });
    const entries = parseFeed(rss, fixture('editor-changelog.rss'));
    assert.deepEqual(
      entries.map((e) => e.title),
      ['2.1: Background agents & plan mode', '2.0: Faster completions', '1.9: Team pricing'],
    );
    assert.equal(entries[0].tag, undefined, 'only GitHub releases have tags');
    assert.equal(entries[0].url, 'https://editor.example.com/changelog/2-1');
    assert.equal(entries[0].published, '2026-10-27T16:00:00.000Z');
    assert.match(entries[0].text, /Agents can now run in the \*\*background\*\*/);
    assert.match(entries[0].text, /inside CDATA does not end the item/);
    assert.equal(entries[1].url, undefined, 'a link to another host is dropped');
    assert.equal(entries[2].text, 'New team plans.', 'content:encoded wins over description');
    assert.notEqual(entries[0].id, entries[1].id);

    const filtered = parseFeed({ ...rss, titleFilter: 'BACKGROUND' }, fixture('editor-changelog.rss'));
    assert.deepEqual(
      filtered.map((e) => e.title),
      ['2.1: Background agents & plan mode'],
      'the title filter ignores case',
    );
  });

  it('splits a CHANGELOG.md on version headings', () => {
    const md = source({
      id: 'tool',
      product: 'Tool',
      kind: 'markdown',
      url: 'https://raw.githubusercontent.com/example/tool/main/CHANGELOG.md',
      homepage: 'https://github.com/example/tool/blob/main/CHANGELOG.md',
      allowHosts: ['raw.githubusercontent.com', 'github.com'],
    });
    const text = fixture('CHANGELOG.md').replace(/\r\n/g, '\n');
    const entries = parseFeed(md, text);
    assert.deepEqual(
      entries.map((e) => e.tag),
      ['2.0.10', '2.0.8', '2.0.7'],
      'Unreleased is no entry and the beta is skipped',
    );
    assert.equal(entries[0].title, 'Tool 2.0.10');
    assert.equal(entries[0].id, entryId('tool', '2.0.10', '2.0.10'));
    assert.match(entries[0].text, /Added `\/rewind`/);
    assert.match(entries[0].text, /### Internal/, 'subsections stay with their version');
    assert.doesNotMatch(entries[0].text, /Work in progress|beta/);
    assert.equal(entries[0].url, 'https://github.com/example/tool/blob/main/CHANGELOG.md');
    assert.equal(entries[0].published, undefined);
    assert.equal(entries[1].published, '2026-10-01T00:00:00.000Z');

    const crlf = parseFeed(md, text.replace(/\n/g, '\r\n'));
    assert.deepEqual(
      crlf.map((e) => e.tag),
      ['2.0.10', '2.0.8', '2.0.7'],
    );
    assert.doesNotMatch(crlf[0].text, /\r/);
    assert.deepEqual(
      parseFeed(md, text, { truncated: true }).map((e) => e.tag),
      ['2.0.10', '2.0.8'],
      'a cut-off file loses its possibly incomplete last section',
    );
  });

  it('reads what it can from a malformed feed and never throws', () => {
    const entries = parseFeed(source({ id: 'example', allowHosts: ['example.com'] }), fixture('malformed.atom'));
    assert.deepEqual(
      entries.map((e) => e.title),
      ['A complete entry', 'Mismatched'],
    );
    assert.equal(entries[0].url, 'https://example.com/notes/good-1');
    assert.equal(entries[0].text, 'Readable.');
    for (const junk of ['', 'not xml at all', '<entry>', '<<<<', '<?xml', '<!--', '<![CDATA[', '<entry><id>x</id>', '\u0000￿', '</entry></item>'])
      assert.doesNotThrow(() => parseFeed(source(), junk), JSON.stringify(junk));
    assert.deepEqual(parseFeed(source({ stable: '(' }), fixture('github-releases.atom')), [], 'an invalid pattern reads nothing instead of throwing');
  });

  it('cuts long entries and stops after 200 entries', () => {
    const long = parseFeed(source(), `<feed>${atomEntry('v2.0.0', '2026-10-29T00:00:00Z', `<p>${'word '.repeat(10_000)}</p>`)}</feed>`);
    assert.ok(long[0].text.length <= ENTRY_TEXT_MAX);
    const many = Array.from({ length: 300 }, (_, i) => atomEntry(`v1.0.${i}`, '2026-10-29T00:00:00Z')).join('');
    assert.equal(parseFeed(source(), `<feed>${many}</feed>`).length, 200);
  });
});

describe('Radar state', () => {
  const now = new Date('2026-10-30T00:00:00Z');

  it('treats the first poll as a baseline: only the last 14 days are queued', () => {
    const state = emptyRadarState();
    const s = sourceStateFor(state, 'agent-cli', source().url);
    const entries = parseFeed(source(), fixture('github-releases.atom'));
    const first = recordEntries(state, s, entries, now);
    assert.equal(first.baseline, true);
    assert.deepEqual(
      first.fresh.map((e) => e.tag),
      ['v1.4.0'],
      'v1.3.2 is from September',
    );
    assert.deepEqual(
      s.seen,
      entries.map((e) => e.id),
    );
    assert.equal(s.baselineAt, now.toISOString());

    const again = recordEntries(state, s, entries, now);
    assert.equal(again.baseline, false);
    assert.deepEqual(again.fresh, []);

    const [newer] = parseFeed(source(), `<feed>${atomEntry('v1.5.0', '2026-10-30T00:00:00Z')}</feed>`);
    const third = recordEntries(state, s, [newer, ...entries], now);
    assert.deepEqual(
      third.fresh.map((e) => e.tag),
      ['v1.5.0'],
    );
    assert.deepEqual(
      state.pending.map((e) => e.tag),
      ['v1.4.0', 'v1.5.0'],
    );
  });

  it('does not take an empty first answer for a baseline', () => {
    const state = emptyRadarState();
    const s = sourceStateFor(state, 'agent-cli', source().url);
    assert.equal(recordEntries(state, s, [], now).baseline, true);
    assert.equal(s.baselineAt, undefined);
    const { fresh, baseline } = recordEntries(state, s, parseFeed(source(), fixture('github-releases.atom')), now);
    assert.equal(baseline, true);
    assert.deepEqual(
      fresh.map((e) => e.tag),
      ['v1.4.0'],
      'the first real list is still a baseline',
    );
  });

  it('queues only the newest undated entry on a baseline', () => {
    const md = source({ id: 'tool', kind: 'markdown', url: 'https://raw.githubusercontent.com/x/y/main/CHANGELOG.md', allowHosts: ['raw.githubusercontent.com'] });
    const state = emptyRadarState();
    const { fresh } = recordEntries(state, sourceStateFor(state, 'tool', md.url), parseFeed(md, '## 3.0.0\n- c\n## 2.0.0\n- b\n## 1.0.0\n- a\n'), now);
    assert.deepEqual(
      fresh.map((e) => e.tag),
      ['3.0.0'],
    );
  });

  it('caps seen ids, new entries per poll and the pending queue', () => {
    const state = emptyRadarState();
    const s = sourceStateFor(state, 'agent-cli', source().url);
    s.baselineAt = now.toISOString();
    const batch = (from: number) => parseFeed(source({ stable: '.' }), `<feed>${Array.from({ length: 200 }, (_, i) => atomEntry(`v9.${from + i}.0`, '2026-10-29T00:00:00Z')).join('')}</feed>`);
    const first = recordEntries(state, s, batch(0), now);
    assert.equal(first.fresh.length, 50, 'a flood of new entries is not all news');
    recordEntries(state, s, batch(200), now);
    assert.equal(s.seen.length, SEEN_CAP);
    assert.equal(s.seen[0], batch(200)[0].id, 'the entries listed now come first');
    for (let i = 0; i < 4; i++) recordEntries(state, s, batch(400 + i * 200), now);
    assert.equal(state.pending.length, PENDING_CAP);
  });

  it('starts a source over when its URL changes', () => {
    const state = emptyRadarState();
    const s = sourceStateFor(state, 'agent-cli', source().url);
    s.bodyHash = 'a'.repeat(64);
    s.baselineAt = now.toISOString();
    const moved = sourceStateFor(state, 'agent-cli', 'https://github.com/example/other/releases.atom');
    assert.equal(moved.bodyHash, undefined);
    assert.equal(moved.baselineAt, undefined);
  });

  it('saves atomically and reads a hand-edited file safely', async () => {
    const { root, cleanup } = tempWorkspace();
    try {
      const file = path.join(root, 'radar', 'state.json');
      assert.deepEqual(await loadRadarState(file), emptyRadarState(), 'a missing file is a fresh state');
      const state = emptyRadarState();
      const s = sourceStateFor(state, 'agent-cli', source().url);
      recordEntries(state, s, parseFeed(source(), fixture('github-releases.atom')), now);
      s.bodyHash = 'b'.repeat(64);
      const pending = state.pending[0];
      const item = {
        id: `${pending.id.slice(0, 16)}-1`,
        entryId: pending.id,
        sourceId: 'agent-cli',
        vendor: 'Example',
        product: 'Agent CLI',
        title: 'Background agents',
        summary: 'Agents keep running while the user does something else.',
        kind: 'feature' as const,
        relevance: 3 as const,
        tags: ['agents' as const],
        match: 'gap' as const,
        featureIds: [],
      };
      state.summarized[pending.id] = [item];
      await saveRadarState(file, state);
      assert.deepEqual(await loadRadarState(file), state);
      assert.deepEqual(readdirSync(path.dirname(file)), ['state.json'], 'no temporary file is left behind');

      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          sources: {
            'agent-cli': { url: source().url, seen: ['not-a-hash', pending.id], etag: '"u-7f3a9c"', lastModified: 'Wed, 28 Oct 2026 10:00:00 GMT', bodyHash: 'nope' },
            ['__proto__']: { url: 'x', seen: [] },
            'Bad Id': { url: 'x', seen: [] },
          },
          pending: [pending, { ...pending, id: 'zz' }, { ...pending, url: 'javascript:alert(1)' }, 'junk'],
          summarized: { [pending.id]: [item, { ...item, id: 'x', title: '<<NEW>>' }, { ...item, entryId: 'f'.repeat(64) }], ['e'.repeat(64)]: [{ ...item, entryId: 'e'.repeat(64) }] },
          quarantine: [{ entry: pending, stage: 'summarize', reason: 'r', at: now.toISOString() }, { entry: pending, stage: 'evil', reason: 'r', at: 'x' }],
        }),
      );
      const loaded = await loadRadarState(file);
      assert.deepEqual(Object.keys(loaded.sources), ['agent-cli']);
      assert.deepEqual(loaded.sources['agent-cli'], { url: source().url, seen: [pending.id] }, 'validators an earlier version kept are dropped, a bad hash too');
      assert.equal(loaded.pending.length, 2);
      assert.equal(loaded.pending[1].url, undefined, 'a non-https link is dropped');
      assert.deepEqual(loaded.summarized, { [pending.id]: [item] }, 'summaries only of waiting entries, and only valid items of their own');
      assert.equal(loaded.quarantine.length, 1);
    } finally {
      cleanup();
    }
  });

  it('starts over only when the file is missing; a corrupt one is set aside, a read error is thrown', async () => {
    const { root, cleanup } = tempWorkspace();
    try {
      const dir = path.join(root, 'radar');
      const file = path.join(dir, 'state.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, '{"version":1,"sources":{');
      assert.deepEqual(await loadRadarState(file), emptyRadarState());
      const aside = readdirSync(dir);
      assert.equal(aside.length, 1);
      assert.match(aside[0], /^state\.broken-\d+\.json$/);
      assert.equal(readFileSync(path.join(dir, aside[0]), 'utf8'), '{"version":1,"sources":{', 'kept for a look');
      for (const content of ['null', '[]']) {
        writeFileSync(file, content);
        assert.deepEqual(await loadRadarState(file), emptyRadarState(), content);
        assert.ok(!existsSync(file), content);
      }

      // A file that cannot be read (here a folder in its place) is not a fresh state: polls and analyses fail and try again later.
      const blocked = path.join(root, 'blocked.json');
      mkdirSync(blocked);
      await assert.rejects(loadRadarState(blocked), (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
      const radar = new Radar({ statePath: blocked, sources: [source()], fetchImpl: (async () => new Response('', { status: 200 })) as typeof fetch, pacer: new HostPacer(0) });
      await assert.rejects(radar.poll());
      await assert.rejects(radar.retryQuarantined());
      assert.ok(statSync(blocked).isDirectory(), 'nothing was saved over it or moved');
    } finally {
      cleanup();
    }
  });
});

describe('Radar fetch', () => {
  let server: http.Server;
  let port = 0;
  let hugeSent = 0;
  const requests: Array<{ host: string; path: string; headers: http.IncomingHttpHeaders }> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push({ host: String(req.headers['x-test-host']), path: req.url ?? '', headers: req.headers });
      switch (req.url) {
        case '/feed.atom':
          if (req.headers['if-none-match'] === '"v1"') {
            res.writeHead(304, { etag: '"v1"' });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/atom+xml', etag: '"v1"', 'last-modified': 'Wed, 28 Oct 2026 10:00:00 GMT' });
          res.end(fixture('github-releases.atom'));
          return;
        case '/not-modified':
          res.writeHead(304);
          res.end();
          return;
        case '/moved':
          res.writeHead(301, { location: 'https://mirror.example.org/feed.atom' });
          res.end();
          return;
        case '/elsewhere':
          res.writeHead(302, { location: 'https://evil.example.net/steal' });
          res.end();
          return;
        case '/downgrade':
          res.writeHead(302, { location: 'http://feeds.example.com/feed.atom' });
          res.end();
          return;
        case '/port':
          res.writeHead(302, { location: 'https://mirror.example.org:8443/feed.atom' });
          res.end();
          return;
        case '/loop':
          res.writeHead(302, { location: '/loop' });
          res.end();
          return;
        case '/hang':
          return; // never answers
        case '/huge': {
          res.writeHead(200, { 'content-type': 'text/plain' });
          const chunk = Buffer.alloc(64_000, 0x61);
          const pump = () => {
            while (!res.destroyed && hugeSent < 50_000_000) {
              hugeSent += chunk.length;
              if (!res.write(chunk)) return void res.once('drain', pump);
            }
            res.end();
          };
          pump();
          return;
        }
        default:
          res.writeHead(500);
          res.end('oops');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  /** Real HTTP to the local server, under the https names the radar insists on (no network). */
  const local = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.protocol, 'https:', 'the radar only ever asks for https');
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-test-host': url.hostname } });
  }) as typeof fetch;

  const feed = (pathname: string, over: Partial<RadarSource> = {}) =>
    source({ id: 'feed', url: `https://feeds.example.com${pathname}`, allowHosts: ['feeds.example.com', 'mirror.example.org'], maxBytes: 100_000, ...over });

  it('sends a plain GET with its User-Agent and nothing the server issued', async () => {
    requests.length = 0;
    const first = await fetchSource(feed('/feed.atom'), { fetchImpl: local });
    assert.equal(first.status, 'ok');
    if (first.status !== 'ok') return;
    assert.equal(first.truncated, false);
    assert.equal(parseFeed(feed('/feed.atom', { allowHosts: ['github.com'] }), first.body).length, 2);
    assert.ok(RADAR_USER_AGENT.startsWith(`OrkaRadar/${VERSION} `));
    // The server sent an ETag and a Last-Modified date; asked again, it gets neither back (no 304).
    const second = await fetchSource(feed('/feed.atom'), { fetchImpl: local });
    assert.equal(second.status, 'ok');
    assert.equal(requests.length, 2);
    for (const { headers } of requests) {
      assert.equal(headers['user-agent'], RADAR_USER_AGENT);
      const sent = Object.keys(headers).filter((h) => !['host', 'connection', 'accept', 'accept-encoding', 'accept-language', 'sec-fetch-mode', 'user-agent', 'x-test-host'].includes(h));
      assert.deepEqual(sent, [], 'no If-None-Match, If-Modified-Since, Cookie or anything else');
    }

    // A 304 answers only a conditional request, which the radar never sends.
    assert.deepEqual(await fetchSource(feed('/not-modified'), { fetchImpl: local }), { status: 'error', error: 'The server answered 304.' });
  });

  it('follows redirects only to the hosts allowed for the source, and only over HTTPS', async () => {
    requests.length = 0;
    const moved = await fetchSource(feed('/moved'), { fetchImpl: local });
    assert.equal(moved.status, 'ok');
    assert.equal(moved.status === 'ok' && moved.url, 'https://mirror.example.org/feed.atom');

    requests.length = 0;
    const elsewhere = await fetchSource(feed('/elsewhere'), { fetchImpl: local });
    assert.equal(elsewhere.status, 'error');
    assert.equal(elsewhere.status === 'error' ? elsewhere.error : '', 'Refused a redirect to evil.example.net: not one of the hosts allowed for this source.');
    assert.deepEqual(
      requests.map((r) => r.host),
      ['feeds.example.com'],
      'the other host is never contacted',
    );

    const downgrade = await fetchSource(feed('/downgrade'), { fetchImpl: local });
    assert.match(downgrade.status === 'error' ? downgrade.error : '', /HTTPS/);
    const port = await fetchSource(feed('/port'), { fetchImpl: local });
    assert.match(port.status === 'error' ? port.error : '', /standard HTTPS port/);
    assert.deepEqual(await fetchSource(feed('/loop'), { fetchImpl: local }), { status: 'error', error: 'Too many redirects.' });
    assert.deepEqual(await fetchSource(feed('/missing'), { fetchImpl: local }), { status: 'error', error: 'The server answered 500.' });
    // A source URL that is not on its own allowed hosts is never fetched at all.
    requests.length = 0;
    assert.equal((await fetchSource(feed('/feed.atom', { allowHosts: ['other.example.com'] }), { fetchImpl: local })).status, 'error');
    assert.equal(requests.length, 0);
  });

  it('gives up after the timeout and stops reading at maxBytes', async () => {
    const started = Date.now();
    const hang = await fetchSource(feed('/hang'), { fetchImpl: local, timeoutMs: 200 });
    assert.deepEqual(hang, { status: 'error', error: 'Timed out after 0.2s.' });
    assert.ok(Date.now() - started < 5_000);

    const controller = new AbortController();
    const pending = fetchSource(feed('/hang'), { fetchImpl: local, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { status: 'error', error: 'Cancelled.' });

    const huge = await fetchSource(feed('/huge', { maxBytes: 100_000 }), { fetchImpl: local });
    assert.equal(huge.status, 'ok');
    assert.equal(huge.status === 'ok' && huge.truncated, true);
    assert.equal(huge.status === 'ok' && huge.body.length, 100_000);
    assert.ok(hugeSent < 50_000_000, `the server had to send ${hugeSent} bytes`);
  });

  it('keeps requests to one host apart', async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = new HostPacer(1_000, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await pacer.wait('github.com');
    await pacer.wait('github.com');
    await pacer.wait('cursor.com');
    await pacer.wait('github.com');
    assert.deepEqual(waits, [1_000, 1_000]);
  });
});

describe('Radar poll', () => {
  it('polls without a model, skips an unchanged feed, respects minIntervalHours and records errors', async () => {
    const { root, cleanup } = tempWorkspace();
    try {
      let now = new Date('2026-10-30T00:00:00Z');
      // Every answer carries validators unique to this "install", as a tracking server would hand out.
      let served = { body: fixture('github-releases.atom'), etag: '"u-7f3a9c-install-42"' };
      let fail = false;
      const calls: string[] = [];
      const sent: Headers[] = [];
      const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
        calls.push(String(input));
        sent.push(new Headers(init.headers));
        if (fail) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
        if (new Headers(init.headers).get('if-none-match') === served.etag) return new Response(null, { status: 304 });
        return new Response(served.body, { status: 200, headers: { etag: served.etag, 'last-modified': 'Thu, 29 Oct 2026 07:42:13 GMT' } });
      }) as typeof fetch;
      const off = source({ id: 'off', url: 'https://github.com/example/off/releases.atom', enabled: false });
      const statePath = path.join(root, 'state.json');
      const radar = new Radar({ statePath, sources: [source(), off], fetchImpl, now: () => now, pacer: new HostPacer(0) });

      const first = await radar.poll();
      assert.deepEqual(
        first.sources.map((s) => [s.id, s.status, s.newEntries]),
        [
          ['agent-cli', 'baseline', 1],
          ['off', 'disabled', 0],
        ],
      );
      assert.deepEqual(
        first.newEntries.map((e) => e.tag),
        ['v1.4.0'],
      );
      assert.equal(first.pending, 1);

      assert.equal((await radar.poll()).sources[0].status, 'skipped', 'polled less than 6 hours ago');
      assert.equal(calls.length, 1);

      now = new Date(now.getTime() + 7 * 3_600_000);
      assert.equal((await radar.poll()).sources[0].status, 'not_modified', 'the same body again: not even parsed');

      served = { body: fixture('github-releases.atom').replace('<entry>', atomEntry('v1.5.0', '2026-10-30T05:00:00Z') + '<entry>'), etag: '"u-8e4b0d-install-42"' };
      const forced = await radar.poll({ force: true });
      assert.deepEqual(
        forced.newEntries.map((e: RadarEntry) => e.tag),
        ['v1.5.0'],
      );
      assert.equal(forced.pending, 2);
      // Nothing the server issued was kept or sent back: every request looked the same.
      assert.equal(sent.length, 3);
      for (const headers of sent) assert.deepEqual([...headers.keys()].sort(), ['accept', 'user-agent']);
      assert.doesNotMatch(readFileSync(statePath, 'utf8'), /u-7f3a9c|u-8e4b0d|07:42:13|etag|lastModified/i);
      // The same body read with another filter is read again.
      const filtered = new Radar({ statePath, sources: [source({ titleFilter: 'background' })], fetchImpl, now: () => now, pacer: new HostPacer(0) });
      assert.equal((await filtered.poll({ force: true })).sources[0].status, 'unchanged');
      assert.equal((await filtered.poll({ force: true })).sources[0].status, 'not_modified');

      fail = true;
      const failed = await radar.poll({ force: true });
      assert.deepEqual(failed.sources[0], { id: 'agent-cli', status: 'error', newEntries: 0, error: 'ENOTFOUND' });
      const status = await radar.status();
      assert.equal(status.pending, 2);
      assert.equal(status.sources[0].lastStatus, 'error');
      assert.equal(status.sources[0].lastError, 'ENOTFOUND');
      assert.equal(status.sources[1].enabled, false);
      assert.ok(!calls.some((c) => c.includes('off')), 'a disabled source is never fetched');
    } finally {
      cleanup();
    }
  });

  it('checks its sources and leaves a cancelled source due', async () => {
    const { root, cleanup } = tempWorkspace();
    try {
      const statePath = path.join(root, 'state.json');
      const checked = new Radar({ statePath, sources: [source(), source({ id: 'evil', stable: '(a+)+$' }), { id: 'junk' }] });
      assert.deepEqual(
        checked.sources.map((s) => s.id),
        ['agent-cli'],
      );
      assert.equal(checked.sourceErrors.length, 2);
      assert.equal(new Radar({ statePath }).sources.length, DEFAULT_SOURCES.length, 'the preset by default');

      const controller = new AbortController();
      const fetchImpl = (async () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }) as typeof fetch;
      const radar = new Radar({ statePath, sources: [source()], fetchImpl, pacer: new HostPacer(0) });
      const result = await radar.poll({ signal: controller.signal });
      assert.deepEqual(result.sources, []);
      assert.equal((await radar.status()).sources[0].lastPolledAt, undefined, 'a cancel is not recorded as a poll');
    } finally {
      cleanup();
    }
  });
});
