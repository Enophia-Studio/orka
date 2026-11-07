// A performance benchmark of the desktop app's sessions (not a test, not shipped): the real app runs
// with --no-window and a real headless Edge/Chrome drives its page, while a fake Claude API streams
// the model's answer. It opens two long sessions (300 messages with code blocks each) and measures:
//   - keystroke to paint in the message box, idle and while an answer streams
//   - main-thread time per streamed chunk (an answer of 2000 chunks)
//   - switching between the two sessions, and opening Settings
//   - how many 'config' messages and full transcript rebuilds the page got
// Run: npm run bench -w orka-desktop   (or: node packages/desktop/test/perf.bench.mjs after a build)
// Prints one JSON object (`--json`: only that). BENCH_TRACE=switch, keys or stream adds a timeline
// summary of that part.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// BENCH_APP: another build to measure (a copy of dist/ from another commit), for before/after runs side by side.
const APP = process.env.BENCH_APP || path.join(here, '..', 'dist', 'orka-desktop.js');
const require = createRequire(import.meta.url);
const { HeadlessBrowser, findBrowser } = require(path.join(here, '..', '..', 'core', 'dist', 'src', 'browser', 'HeadlessBrowser.js'));
if (!existsSync(APP)) throw new Error('build first: npm run build -w orka-desktop');
if (!findBrowser()) throw new Error('no Chrome/Edge installed');

const MESSAGES = 300;
const CHUNKS = 2000;
const KEYS = 60;
const SWITCHES = 6;
const SETTINGS_OPENS = 5;
const quiet = process.argv.includes('--json');
const say = (...a) => quiet || console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 60_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const folderKey = (root) => createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);

// ------------------------------------------------------------------ the sessions

const code = (n) =>
  '```ts\n' +
  Array.from({ length: 12 }, (_, i) => `export function step${n}_${i}(value: number): number {\n  return value * ${i + 1} + ${n}; // keep it simple\n}`).join('\n') +
  '\n```';
function answerText(n) {
  return `Here is part **${n}** of the change, with \`inline code\` and a list:\n\n- first point about ${n}\n- second point\n- third point\n\n${code(n)}\n\nAnd a closing paragraph that explains what the code above does in a few more words.`;
}
function seedTask(home, folder, title) {
  const dir = path.join(home, 'tasks', folderKey(folder));
  mkdirSync(dir, { recursive: true });
  const id = `bench-${title.toLowerCase()}`;
  const items = [];
  const messages = [];
  for (let i = 0; i < MESSAGES / 2; i++) {
    items.push({ kind: 'user', id: `u${i}`, text: `Request ${i}: please change the module so step ${i} works` });
    items.push({ kind: 'assistant', id: `a${i}`, text: answerText(i), reasoning: '', streaming: false, model: 'claude-opus-5-5' });
    messages.push({ role: 'user', content: [{ type: 'text', text: `<context></context>\nRequest ${i}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  }
  const now = new Date().toISOString();
  const snapshot = { version: 1, id, title, createdAt: now, updatedAt: now, messages, subagentProfiles: [], usageByAgent: [], view: { items, running: false, phase: 'idle', changes: [] } };
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(snapshot));
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ [id]: { id, title, createdAt: now, updatedAt: now, requests: MESSAGES / 2 } }));
  return id;
}

// ------------------------------------------------------------------ the fake API: one long streamed answer

const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function streamedChunks() {
  let text = '';
  while (text.length < CHUNKS * 12) text += `${answerText(text.length)}\n\n`;
  const size = Math.ceil(text.length / CHUNKS);
  return Array.from({ length: CHUNKS }, (_, i) => text.slice(i * size, (i + 1) * size));
}
let streamDone;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(ev('message_start', { type: 'message_start', message: { id: 'msg_bench', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }));
    res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    const chunks = streamedChunks();
    // About 500 chunks a second, in small bursts (as a fast model streams).
    for (let i = 0; i < chunks.length; i += 5) {
      res.write(chunks.slice(i, i + 5).map((text) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })).join(''));
      await sleep(10);
    }
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: CHUNKS } }));
    res.end(ev('message_stop', { type: 'message_stop' }));
    streamDone?.();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ the app

const home = mkdtempSync(path.join(tmpdir(), 'orka-bench-home-'));
const workA = mkdtempSync(path.join(tmpdir(), 'orka-bench-a-'));
const workB = mkdtempSync(path.join(tmpdir(), 'orka-bench-b-'));
mkdirSync(path.join(home, 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, 'desktop', 'settings.json'),
  JSON.stringify({ provider: 'claude', 'claude.model': 'claude-opus-5-5', 'supervisor.enabled': false, language: 'en', 'claudeCode.autoUpdate': false }),
);
const taskA = seedTask(home, workA, 'Alpha');
const taskB = seedTask(home, workB, 'Beta');

const app = spawn(process.execPath, [APP, workA, '--no-window'], {
  env: { ...process.env, ORKA_HOME: home, ORKA_NO_UPDATE_CHECK: '1', ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'bench-key-for-fake-server' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
app.stderr.on('data', (c) => (out += c));
const url = await new Promise((resolve, reject) => {
  app.stdout.on('data', (c) => {
    out += c;
    const found = /ORKA_DESKTOP_URL=(\S+)/.exec(out)?.[1];
    if (found) resolve(found);
  });
  app.once('exit', (code) => reject(new Error(`the app exited (${code}): ${out}`)));
});

const browser = new HeadlessBrowser();
// HeadlessBrowser keeps its DevTools session private; this script reaches in for raw CDP calls and events.
const cdp = (method, params = {}) => browser.page(method, params);
const evaluate = (expression) => browser.evaluate(expression);
const result = {};
const trace = { events: [] };

// What the page receives and how often the transcript is rebuilt whole, counted from the first script on.
const PROBE = `(() => {
  const perf = (window.__perf = { msgs: {}, time: {}, same: 0, events: 0, rebuilds: 0, live: undefined, session: undefined });
  let started = 0;
  let lastConfig;
  // The page's own handler runs between these two (it is added after the first, before the second).
  document.addEventListener('DOMContentLoaded', () =>
    window.addEventListener('message', (e) => {
      const type = e.data?.type;
      if (typeof type === 'string') perf.time[type] = (perf.time[type] || 0) + performance.now() - started;
    }),
  );
  window.addEventListener('message', (e) => {
    started = performance.now();
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'config' || m.type === 'init') {
      const json = JSON.stringify(m.config);
      if (m.type === 'config' && json === lastConfig) perf.same++;
      lastConfig = json;
    }
    perf.msgs[m.type] = (perf.msgs[m.type] || 0) + 1;
    if (m.type === 'event') perf.events++;
    if (m.type === 'live') perf.live = m.sessions;
    if (m.type === 'init') perf.session = m.sessionId;
  }, true);
  const watch = () => {
    const tr = document.getElementById('transcript');
    if (!tr) return requestAnimationFrame(watch);
    new MutationObserver((records) => {
      for (const r of records) if (r.removedNodes.length >= 20) perf.rebuilds++;
    }).observe(tr, { childList: true });
  };
  document.addEventListener('DOMContentLoaded', watch);
  // Time from a key's input event to the frame after it painted.
  perf.keys = [];
  document.addEventListener('input', (e) => {
    if (e.target?.id !== 'input') return;
    const at = e.timeStamp;
    requestAnimationFrame(() => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => perf.keys.push(performance.now() - at);
      port2.postMessage(0);
    });
  }, true);
})();`;
await evaluate('1');
await cdp('Performance.enable');
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

const metrics = async () => Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const frame = () => evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))');
const counts = () => evaluate('({ configSame: window.__perf.same, configMs: Math.round(window.__perf.time.config || 0), initMs: Math.round(window.__perf.time.init || 0), eventMs: Math.round(window.__perf.time.event || 0), config: window.__perf.msgs.config || 0, init: window.__perf.msgs.init || 0, sessions: window.__perf.msgs.sessions || 0, live: window.__perf.msgs.live || 0, rebuilds: window.__perf.rebuilds, events: window.__perf.events })');
const diff = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));
const ms = (s) => Math.round(s * 1000 * 100) / 100;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const round = (v) => Math.round(v * 100) / 100;
  return { n: sorted.length, mean: round(sorted.reduce((s, v) => s + v, 0) / sorted.length), p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]) };
};
const items = () => evaluate('document.querySelectorAll("#transcript > [data-id]").length');

async function typeKeys(n) {
  await evaluate('window.__perf.keys = []');
  for (let i = 0; i < n; i++) {
    const ch = 'abcdefghijklmnopqrstuvwxyz '[i % 27];
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(30);
  }
  await until(() => evaluate(`window.__perf.keys.length >= ${n}`), 'the keys');
  return stats(await evaluate('window.__perf.keys'));
}

try {
  // Start up and open the long task of folder A.
  const t0 = Date.now();
  await browser.navigate(url);
  await until(() => evaluate('!!document.querySelector("#input")'), 'the chat UI');
  await sleep(1500);
  result.startup = { ms: Date.now() - t0, ...(await counts()) };
  say('startup', result.startup);

  let before = await counts();
  let open = Date.now();
  await post({ type: 'openTask', id: taskA });
  await until(async () => (await items()) >= MESSAGES, 'task A');
  await frame();
  result.openTask = { ms: Date.now() - open };
  open = Date.now();
  await post({ type: 'openFolder', path: workB });
  await until(async () => (await evaluate('document.querySelector(".folder-btn span")?.textContent')) === path.basename(workB), 'folder B');
  await post({ type: 'openTask', id: taskB });
  await until(async () => (await items()) >= MESSAGES, 'task B');
  await frame();
  result.openTaskOtherFolder = { ms: Date.now() - open, ...diff(before, await counts()) };
  say('open', result.openTask, result.openTaskOtherFolder);
  await sleep(1000);

  // Switch back and forth between the two sessions.
  const live = await until(async () => {
    const sessions = await evaluate('window.__perf.live');
    return sessions?.length >= 2 ? sessions : undefined;
  }, 'two open sessions');
  const ids = live.map((s) => s.id);
  const switches = [];
  before = await counts();
  let m0 = await metrics();
  for (let i = 0; i < SWITCHES; i++) {
    if (process.env.BENCH_TRACE === 'switch' && i === SWITCHES - 1) await startTrace();
    const current = await evaluate('window.__perf.session');
    const target = ids.find((id) => id !== current);
    const took = await evaluate(`new Promise((resolve) => {
      const start = performance.now();
      const done = () => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
      const check = () => (window.__perf.session === ${JSON.stringify(target)} && document.querySelectorAll('#transcript > [data-id]').length >= ${MESSAGES} ? done() : setTimeout(check, 1));
      fetch('/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ type: 'switchSession', sessionId: target }))} });
      check();
    })`);
    switches.push(took);
    await sleep(300);
  }
  if (process.env.BENCH_TRACE === 'switch') say('trace of one switch', await stopTrace());
  let m1 = await metrics();
  result.sessionSwitch = { ...stats(switches), taskMsEach: ms((m1.TaskDuration - m0.TaskDuration) / SWITCHES), scriptMsEach: ms((m1.ScriptDuration - m0.ScriptDuration) / SWITCHES), layoutMsEach: ms((m1.LayoutDuration - m0.LayoutDuration) / SWITCHES), styleMsEach: ms((m1.RecalcStyleDuration - m0.RecalcStyleDuration) / SWITCHES), ...diff(before, await counts()) };
  say('switch', result.sessionSwitch);

  // Keystrokes in the message box, idle (in session A, 300 messages).
  await browser.clickSelector('#input');
  await sleep(300);
  m0 = await metrics();
  if (process.env.BENCH_TRACE === 'keys') await startTrace();
  const idleKeys = await typeKeys(KEYS);
  if (process.env.BENCH_TRACE === 'keys') say('trace of the keys', await stopTrace());
  m1 = await metrics();
  result.keystrokeIdle = { ...idleKeys, taskMsEach: ms((m1.TaskDuration - m0.TaskDuration) / KEYS) };
  say('keys idle', result.keystrokeIdle);
  await sleep(800);

  // Open and close Settings.
  before = await counts();
  const opens = [];
  for (let i = 0; i < SETTINGS_OPENS; i++) {
    opens.push(
      await evaluate(`new Promise((resolve) => {
        const start = performance.now();
        document.querySelector('[data-action="open-settings"]').click();
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
      })`),
    );
    await sleep(400);
    await evaluate('document.querySelector("[data-action=close-settings]")?.click()');
    await sleep(300);
  }
  result.openSettings = { ...stats(opens), ...diff(before, await counts()) };
  say('settings', result.openSettings);

  // A streamed answer of 2000 chunks, typing while it streams.
  await evaluate('document.querySelector("#input").value = ""; document.querySelector("#input").dispatchEvent(new Event("input"))');
  await browser.clickSelector('#input');
  await cdp('Input.insertText', { text: 'Write the whole module' });
  before = await counts();
  const streamed = new Promise((r) => (streamDone = r));
  m0 = await metrics();
  const s0 = Date.now();
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate('document.body.classList.contains("busy")'), 'the run');
  if (process.env.BENCH_TRACE === 'stream') await startTrace();
  const streamingKeys = await typeKeys(KEYS);
  await streamed;
  if (process.env.BENCH_TRACE === 'stream') say('trace of the stream (while typing)', await stopTrace());
  await until(() => evaluate('!document.body.classList.contains("busy")'), 'the end of the run');
  await frame();
  const m2 = await metrics();
  const c = diff(before, await counts());
  result.stream = {
    chunks: CHUNKS,
    wallMs: Date.now() - s0,
    taskMsPerChunk: ms((m2.TaskDuration - m0.TaskDuration) / CHUNKS),
    scriptMsPerChunk: ms((m2.ScriptDuration - m0.ScriptDuration) / CHUNKS),
    layoutMsTotal: ms(m2.LayoutDuration - m0.LayoutDuration),
    styleMsTotal: ms(m2.RecalcStyleDuration - m0.RecalcStyleDuration),
    ...c,
  };
  result.keystrokeWhileStreaming = streamingKeys;
  say('stream', result.stream);
  say('keys while streaming', result.keystrokeWhileStreaming);
  console.log(JSON.stringify(result, null, quiet ? 0 : 2));
} finally {
  browser.close();
  app.kill();
  server.close();
  await sleep(500);
  for (const dir of [home, workA, workB]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// BENCH_TRACE=switch|keys|stream: a timeline trace of one session switch, the idle keystrokes or the streamed answer, summed by event (and forced layouts by the function that caused them).
async function startTrace() {
  trace.events = [];
  browser.events.add((method, params) => {
    if (method === 'Tracing.dataCollected') trace.events.push(...params.value);
  });
  await cdp('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.stack', transferMode: 'ReportEvents' });
}
async function stopTrace() {
  const done = new Promise((resolve) => browser.events.add((method) => method === 'Tracing.tracingComplete' && resolve()));
  await cdp('Tracing.end');
  await done;
  const sum = {};
  for (const e of trace.events) {
    if (e.ph !== 'X' || !e.dur) continue;
    let name = e.name;
    if (name === 'Layout' || name === 'UpdateLayoutTree') {
      const frame = e.args?.beginData?.stackTrace?.[0];
      name += frame ? ` <- ${frame.functionName || '(anonymous)'}:${frame.lineNumber}` : '';
    }
    const s = (sum[name] ??= { n: 0, ms: 0 });
    s.n++;
    s.ms += e.dur / 1000;
  }
  return Object.entries(sum)
    .filter(([, s]) => s.ms >= 1)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 25)
    .map(([name, s]) => `${s.ms.toFixed(1).padStart(7)} ms  ${String(s.n).padStart(4)}x  ${name}`)
    .join('\n');
}

function post(message) {
  return evaluate(`fetch('/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(message))} }).then((r) => r.status)`);
}
