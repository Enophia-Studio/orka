// End-to-end tests of the desktop app (dist/orka-desktop.js): the real app runs with --no-window
// and a real headless Edge/Chrome drives its UI, while a fake Claude API scripts the model's turns.
// Everything else is real: the shared controller, the local server and its security checks,
// in-app dialogs, file writes, task history and (on Windows) DPAPI-protected API keys.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'dist', 'orka-desktop.js');
const require = createRequire(import.meta.url);
const core = path.join(here, '..', '..', 'core', 'dist', 'src', 'browser', 'HeadlessBrowser.js');
const { HeadlessBrowser, findBrowser } = existsSync(core) ? require(core) : {};

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const start = (id) => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }];
const toolUse = (id, name, input) =>
  sse([
    start(`msg_${id}`),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
const reply = (text) =>
  sse([
    start('msg_text'),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe('Orka desktop app', { skip: (!existsSync(APP) && 'build first (npm run build -w orka-desktop)') || (!HeadlessBrowser && 'build the core package first') || (!findBrowser?.() && 'no Chrome/Edge installed') }, () => {
  let server;
  let baseURL;
  let script = [];
  let requests = [];
  let home;
  let work;
  let app;
  let browser;

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        const body = JSON.parse(raw);
        requests.push({ body, headers: req.headers });
        const next = script.shift();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(next ? next(body) : reply('(script ended)'));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'orka-desktop-home-'));
    work = mkdtempSync(path.join(tmpdir(), 'orka-desktop-work-'));
    mkdirSync(path.join(home, 'desktop'), { recursive: true });
    writeFileSync(
      path.join(home, 'desktop', 'settings.json'),
      // A fixed provider and no background Claude Code updates in tests.
      JSON.stringify({ provider: 'claude', 'claude.model': 'claude-opus-5-5', 'supervisor.enabled': false, language: 'en', 'claudeCode.autoUpdate': false }),
    );
    requests = [];
    script = [];
    browser = new HeadlessBrowser();
  });
  afterEach(() => {
    browser.close();
    app?.kill();
    app = undefined;
  });

  /** What the running app printed (for failure messages). */
  let appOutput = '';

  /** Start the app without a window; resolves with its start URL. `node` is put before the app on Node's command line. */
  function launch(folder = work, { node = [], env = {} } = {}) {
    app = spawn(process.execPath, [...node, APP, folder, '--no-window'], {
      // No update check against GitHub from tests.
      env: { ...process.env, ORKA_HOME: home, ORKA_DEBUG: '1', ORKA_NO_UPDATE_CHECK: '1', ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'test-key-for-fake-server', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    appOutput = '';
    app.stderr.on('data', (c) => (appOutput = out += c));
    return new Promise((resolve, reject) => {
      app.stdout.on('data', (c) => {
        appOutput = out += c;
        const url = /ORKA_DESKTOP_URL=(\S+)/.exec(out)?.[1];
        if (url) resolve(url);
      });
      app.once('exit', (code) => reject(new Error(`the app exited (${code}): ${out}`)));
    });
  }

  const text = async () => (await browser.text()).text;
  const post = (message) =>
    browser.evaluate(`fetch('/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(message))} }).then((r) => r.status)`);

  it('runs a task from its own UI, then reverts it through an in-app dialog', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await browser.evaluate('document.querySelector(".folder-btn span")?.textContent'), path.basename(work), 'the folder is shown');

    script = [
      () => toolUse('toolu_w', 'write_file', { path: 'notes/hello.txt', content: 'Hello from Orka Desktop\n' }),
      () => reply('Created notes/hello.txt for you.'),
    ];
    await browser.clickSelector('#input');
    await browser.type('Create a hello note');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('Created notes/hello.txt for you.'), 'the reply');
    assert.equal(readFileSync(path.join(work, 'notes', 'hello.txt'), 'utf8'), 'Hello from Orka Desktop\n');
    assert.equal(requests[0].headers['x-api-key'], 'test-key-for-fake-server');
    assert.ok(requests[0].body.tools.some((t) => t.name === 'browser'));

    // "Revert all" asks first - inside the UI, since there is no VS Code to ask.
    await browser.clickSelector('[data-action="revert-all"]');
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog")'), 'the confirmation dialog');
    assert.match(await text(), /Revert the 1 AI-changed file\?/);
    await browser.clickSelector('.modal-backdrop [data-action="dialog-action"]');
    await until(() => !existsSync(path.join(work, 'notes', 'hello.txt')), 'the revert');
    assert.equal(await browser.evaluate('!!document.querySelector(".modal-backdrop")'), false, 'the dialog closed');
  });

  it('switches folders from the UI and keeps a recent list', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'orka-desktop-other-'));
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await post({ type: 'openFolder', path: other }), 204);
    await until(async () => (await browser.evaluate('document.querySelector(".folder-btn span")?.textContent')) === path.basename(other), 'the folder switch');
    const state = JSON.parse(readFileSync(path.join(home, 'desktop', 'state.json'), 'utf8'));
    assert.deepEqual(state.global.recentFolders.slice(0, 2), [path.resolve(other), path.resolve(work)]);
    rmSync(other, { recursive: true, force: true });
  });

  it('lists sessions on the left, reopens one, and follows the theme and layout settings', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await browser.evaluate('document.documentElement.dataset.layout'), 'ide');
    assert.equal(await browser.evaluate('!!document.querySelector("#sidebar:not([hidden]) .side-new")'), true, 'the session list is shown');
    // Closed, the list becomes a rail of icons, and the conversation still fills the window.
    await browser.clickSelector('.side-head [data-action="toggle-sidebar"]');
    await until(() => browser.evaluate('document.querySelector("#sidebar").classList.contains("collapsed")'), 'the rail');
    assert.equal(await browser.evaluate('document.querySelector(".main-col").getBoundingClientRect().width > innerWidth - 160'), true, 'the conversation fills the window');
    await browser.clickSelector('.side-rail [data-action="toggle-sidebar"]');
    await until(() => browser.evaluate('!document.querySelector("#sidebar").classList.contains("collapsed")'), 'the list again');

    script = [() => reply('All set.')];
    await browser.clickSelector('#input');
    await browser.type('Tidy up the readme');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('All set.'), 'the reply');
    // Saved when the request finished, then listed under its folder.
    const id = await until(() => browser.evaluate('document.querySelector(".side-item .side-open[data-id]")?.dataset.id'), 'the saved session');
    assert.match(await browser.evaluate('document.querySelector("#side-list").textContent'), /Tidy up the readme/);
    assert.equal(await browser.evaluate(`document.querySelector('.side-open[data-id="${id}"]').closest('.side-item').classList.contains('current')`), true);

    await browser.clickSelector('.side-new');
    await until(async () => !(await text()).includes('All set.'), 'a new session');
    await browser.clickSelector(`.side-open[data-id="${id}"]`);
    await until(async () => (await text()).includes('All set.'), 'the session reopened');

    await browser.clickSelector('#theme-switch [data-value="light"]');
    await until(async () => (await browser.evaluate('document.documentElement.dataset.theme')) === 'light', 'the light theme');
    assert.equal(JSON.parse(readFileSync(path.join(home, 'desktop', 'settings.json'), 'utf8'))['desktop.theme'], 'light');

    // The layout is chosen as the page loads: changing it reloads the window once.
    assert.equal(await post({ type: 'setSetting', key: 'desktop.layout', value: 'classic' }), 204);
    await until(async () => (await browser.evaluate('document.documentElement.dataset.layout').catch(() => undefined)) === 'classic', 'the classic layout');
    await until(async () => (await text()).includes('All set.'), 'the chat after the reload');
    assert.equal(await browser.evaluate('!!document.querySelector("#sidebar")'), false);
    assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'light', 'the theme stays');
  });

  it('shows Radar in a tab next to the plan and changes: off, naming every site it would contact, fetching nothing', async () => {
    // Every fetch the app makes is written down.
    const probe = path.join(home, 'fetch-probe.cjs');
    const fetchLog = path.join(home, 'fetches.log');
    writeFileSync(
      probe,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(fetchLog)}, 'probe loaded\\n');
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  fs.appendFileSync(${JSON.stringify(fetchLog)}, (typeof input === 'string' ? input : input.url ?? String(input)) + '\\n');
  return real(input, init);
};
`,
    );
    const url = await launch(work, { node: ['--require', probe] });
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    // A new session has no plan or changes: the side panel opens on Radar.
    await until(() => browser.evaluate('!!document.querySelector(".topbar .aside-btn")'), 'the side panel switch');
    assert.equal(await browser.evaluate('document.querySelector("#aside").hidden'), true, 'closed until asked for');
    await browser.clickSelector('.topbar .aside-btn');
    await until(() => browser.evaluate('!document.querySelector("#radar-panel").hidden'), 'the Radar tab');
    assert.equal(await browser.evaluate('document.querySelector("#aside-tab-radar").getAttribute("aria-selected")'), 'true');
    assert.equal(await browser.evaluate('document.querySelector("#aside-tab-task").disabled'), true, 'no plan or changes to show yet');
    const panel = await browser.evaluate('document.querySelector("#radar-panel").textContent');
    assert.match(panel, /It is off: nothing is fetched\./);
    const hosts = await browser.evaluate('[...document.querySelectorAll("#radar-panel .radar-hosts code")].map((c) => c.textContent)');
    assert.deepEqual(
      [...hosts].sort(),
      ['code.visualstudio.com', 'cursor.com', 'github.blog', 'github.com', 'kiro.dev', 'learn.chatgpt.com', 'raw.githubusercontent.com', 'www.cursor.com'],
    );
    assert.equal(await browser.evaluate('!!document.querySelector("#radar-panel [data-action=radar-switch][data-on=true]")'), true, 'turning it on is a click away');
    // The session list offers it too (and its rail, when closed).
    assert.equal(await browser.evaluate('!!document.querySelector("#side-radar [data-action=open-radar]")'), true);

    // Nothing was fetched from any of them, and Radar wrote nothing.
    await sleep(1500);
    const [loaded, ...fetched] = readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean);
    assert.equal(loaded, 'probe loaded', 'the app ran with the probe');
    assert.deepEqual(
      fetched.filter((u) => hosts.includes(new URL(u).hostname)),
      [],
    );
    assert.equal(existsSync(path.join(home, 'radar')), false);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'desktop', 'settings.json'), 'utf8'))['radar.enabled'], undefined);

    // Radar was the tab open last; once the task changes a file, its changes show by themselves.
    script = [() => toolUse('toolu_w', 'write_file', { path: 'notes/radar.txt', content: 'Plan\n' }), () => reply('Wrote notes/radar.txt.')];
    await browser.clickSelector('#input');
    await browser.type('Write a note');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('Wrote notes/radar.txt.'), 'the reply');
    await until(() => browser.evaluate('!document.querySelector("#aside-task").hidden'), 'the plan and changes');
    assert.equal(await browser.evaluate('document.querySelector("#radar-panel").hidden'), true);
    assert.equal(await browser.evaluate('document.querySelector("#aside-tab-task").getAttribute("aria-selected")'), 'true');
  });

  /** A TypeScript file with Windows line endings, and a junction that leads out of the folder. */
  function filesFixture() {
    const outside = mkdtempSync(path.join(tmpdir(), 'orka-desktop-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
    mkdirSync(path.join(work, 'src'));
    const hello = "export const greeting = 'hello';\r\nexport function greet(name: string): string {\r\n  return `${greeting}, ${name}`;\r\n}\r\n";
    writeFileSync(path.join(work, 'src', 'hello.ts'), hello);
    symlinkSync(outside, path.join(work, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
    return { hello, outside };
  }

  /** Put the editor's cursor at the start of a line (1-based), as a click there would. */
  const cursorAtLine = (line) =>
    browser.evaluate(`(() => {
      document.querySelector('.cm-content').focus();
      const at = document.querySelectorAll('.cm-line')[${line - 1}];
      const range = document.createRange();
      range.setStart(at, 0);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
  const ctrlS = () =>
    browser.evaluate(`document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))`);

  it('opens a file from the Files tab in the editor and saves it with its own line endings', async () => {
    const { hello, outside } = filesFixture();
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      // CodeMirror's styles must pass the page's CSP (they carry its nonce).
      await browser.evaluate(`window.cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.cspViolations.push(e.violatedDirective + ' ' + e.blockedURI))`);
      assert.equal(await browser.evaluate('document.querySelector("#aside").hidden'), true, 'the side panel is closed');

      await browser.clickSelector('#side-files [data-action="open-files"]');
      await until(() => browser.evaluate('!!document.querySelector("#files-panel:not([hidden]) [data-path=src]")'), 'the Files tree');
      assert.equal(await browser.evaluate('document.querySelector("#aside-tab-files").getAttribute("aria-selected")'), 'true');
      assert.equal(await browser.evaluate('!!document.querySelector("#files-panel [data-path=out]")'), false, 'a junction out of the folder is not listed');

      await browser.clickSelector('#files-panel [data-path="src"]');
      await until(() => browser.evaluate('!!document.querySelector("#files-panel [data-path=\'src/hello.ts\']")'), 'the src folder');
      await browser.clickSelector('#files-panel [data-path="src/hello.ts"]');
      await until(() => browser.evaluate('!!document.querySelector("#editor-pane:not([hidden]) .cm-editor .tok-keyword")'), 'the editor with the file');
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".cm-editor")).display'), 'flex', "CodeMirror's base styles apply");
      assert.equal(await browser.evaluate('document.querySelector("#transcript").hidden'), true, 'the file shows in place of the conversation');
      assert.match(await browser.evaluate('document.querySelector("#editor-status").textContent'), /CRLF/);
      assert.deepEqual(await browser.evaluate('window.cspViolations'), []);

      await cursorAtLine(1);
      await browser.type('// typed ');
      await until(() => browser.evaluate('!!document.querySelector("#editor-head .dirty-dot")'), 'the unsaved mark');
      await ctrlS();
      const saved = `// typed ${hello}`;
      await until(() => readFileSync(path.join(work, 'src', 'hello.ts'), 'utf8') === saved, 'the save, with CRLF kept');
      await until(() => browser.evaluate('!document.querySelector("#editor-head .dirty-dot")'), 'a clean buffer');

      // Another program writes the file meanwhile: the next save is refused and the disk keeps its text.
      const external = hello.replace('hello', 'hi there');
      writeFileSync(path.join(work, 'src', 'hello.ts'), external);
      await cursorAtLine(2);
      await browser.type('// mine ');
      await until(() => browser.evaluate('!!document.querySelector("#editor-head .dirty-dot")'), 'the unsaved mark');
      await ctrlS();
      await until(async () => /Changed on disk/.test(await browser.evaluate('document.querySelector("#editor-banner").textContent')), 'the conflict banner');
      assert.equal(readFileSync(path.join(work, 'src', 'hello.ts'), 'utf8'), external);
      assert.deepEqual(await browser.evaluate('window.cspViolations'), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sends the selected lines, and the open file, to the agent', async () => {
    const { outside } = filesFixture();
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      await browser.clickSelector('#side-files [data-action="open-files"]');
      await until(() => browser.evaluate('!!document.querySelector("#files-panel:not([hidden]) [data-path=src]")'), 'the Files tree');
      await browser.clickSelector('#files-panel [data-path="src"]');
      await until(() => browser.evaluate('!!document.querySelector("#files-panel [data-path=\'src/hello.ts\']")'), 'the src folder');
      await browser.clickSelector('#files-panel [data-path="src/hello.ts"]');
      await until(() => browser.evaluate('!!document.querySelector("#editor-pane:not([hidden]) .cm-editor .tok-keyword")'), 'the editor with the file');

      // Lines 2 and 3, selected with the keyboard.
      await browser.evaluate(`(() => {
        const content = document.querySelector('.cm-content');
        content.focus();
        const key = (key, shiftKey = false) => content.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, shiftKey, bubbles: true, cancelable: true }));
        key('ArrowDown');
        key('ArrowDown', true);
        key('End', true);
      })()`);
      await until(() => browser.evaluate('!document.querySelector("[data-action=send-selection]").disabled'), 'a selection');
      await browser.clickSelector('[data-action="send-selection"]');
      await until(() => browser.evaluate('document.querySelector("#chips .editor-chip")?.textContent.includes("hello.ts:2–3")'), 'the selection chip');

      script = [() => reply('Explained.'), () => reply('Read it.')];
      const ask = async (message, count) => {
        await browser.clickSelector('#input');
        await browser.type(message);
        await browser.clickSelector('#send');
        await until(() => requests.length === count, 'the request');
        await until(() => browser.evaluate('!document.body.classList.contains("busy")'), 'the end of the run');
      };
      await ask('Explain these lines', 1);
      const first = JSON.stringify(requests[0].body.messages);
      assert.match(first, /Selected lines 2-3/);
      assert.ok(first.includes('export function greet(name: string): string {'), 'the selected text goes along');
      assert.equal(await browser.evaluate('document.querySelectorAll("#chips .chip").length'), 0, 'the chip is used up');

      await browser.clickSelector('[data-action="attach-open-file"]');
      await until(() => browser.evaluate('[...document.querySelectorAll("#chips .chip")].some((c) => c.textContent.includes("src/hello.ts"))'), 'the file chip');
      await ask('What does this file do?', 2);
      assert.match(JSON.stringify(requests[1].body.messages), /<attached_file path=\\"src\/hello\.ts\\">/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /** Every message the page posts to the app, as sent (window.posted). */
  const recordPosts = () =>
    browser.evaluate(`(() => {
      window.posted = [];
      const real = window.fetch;
      window.fetch = (url, init) => {
        if (url === '/message') window.posted.push(JSON.parse(init.body));
        return real(url, init);
      };
    })()`);

  /** Type a message and send it; resolves when the run has ended. */
  const ask = async (message, reply) => {
    await browser.clickSelector('#input');
    await browser.type(message);
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes(reply), 'the reply');
    await until(() => browser.evaluate('!document.body.classList.contains("busy")'), 'the end of the run');
  };

  /** Show the plan and changes in the side panel. */
  const showChanges = async () => {
    if (await browser.evaluate('document.querySelector("#aside").hidden')) await browser.clickSelector('.topbar .aside-btn');
    if ((await browser.evaluate('document.querySelector("#aside-tab-task").getAttribute("aria-selected")')) !== 'true') await browser.clickSelector('#aside-tab-task');
    await until(() => browser.evaluate('!document.querySelector("#aside-task").hidden && !!document.querySelector(".changes li")'), 'the changes');
  };

  it('shows the changed parts of a file highlighted, and keeps one by its header', async () => {
    mkdirSync(path.join(work, 'src'));
    const before = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
    const after = 'export function add(a: number, b: number): number {\n  // Sum.\n  return b + a;\n}\n';
    writeFileSync(path.join(work, 'src', 'calc.ts'), before);
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    // The app asks once more for a build or test after unverified changes.
    script = [() => toolUse('toolu_w', 'write_file', { path: 'src/calc.ts', content: after }), () => reply('Swapped the operands.'), () => reply('Nothing to build.')];
    await ask('Swap the operands', 'Nothing to build.');
    await recordPosts();
    await showChanges();

    await browser.clickSelector('[data-action="toggle-hunks"]');
    await until(() => browser.evaluate('!!document.querySelector(".hunk-body .hl.add .tok-comment")'), 'the highlighted hunk');
    assert.equal(await browser.evaluate('!!document.querySelector(".hunk-body .hl.del .tok-keyword")'), true, 'removed lines are highlighted too');
    assert.equal(await browser.evaluate('!!document.querySelector(".hunk-body [style]")'), false, 'classes only');
    assert.ok((await browser.evaluate('document.querySelector(".hunk-body").textContent.split("\\n")')).includes('+  // Sum.'), 'the text is unchanged');

    await browser.clickSelector('[data-action="keep-hunk"]');
    await until(() => browser.evaluate('document.querySelector("#changes-panel").hidden'), 'the change kept');
    const keep = await browser.evaluate('window.posted.find((m) => m.type === "keepHunk")');
    assert.equal(keep?.index, 0);
    assert.equal(keep?.header, '@@ -1,3 +1,4 @@', 'the header goes along');
    assert.equal(readFileSync(path.join(work, 'src', 'calc.ts'), 'utf8'), after);
  });

  it('keeps a file the user edited after the agent: Revert all, Go back, then undoes only the agent part', async () => {
    const notes = path.join(work, 'notes', 'hello.txt');
    mkdirSync(path.join(work, 'notes'));
    writeFileSync(notes, 'one\ntwo\nthree\nfour\nfive\nsix\n');
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    script = [() => toolUse('toolu_w', 'write_file', { path: 'notes/hello.txt', content: 'ONE\ntwo\nthree\nfour\nfive\nsix\n' }), () => reply('Shouted the first line.')];
    await ask('Shout the first line', 'Shouted the first line.');

    // The user opens the file and changes its last line.
    await browser.clickSelector('#side-files [data-action="open-files"]');
    await until(() => browser.evaluate('!!document.querySelector("#files-panel:not([hidden]) [data-path=notes]")'), 'the Files tree');
    await browser.clickSelector('#files-panel [data-path="notes"]');
    await until(() => browser.evaluate('!!document.querySelector("#files-panel [data-path=\'notes/hello.txt\']")'), 'the notes folder');
    await browser.clickSelector('#files-panel [data-path="notes/hello.txt"]');
    await until(() => browser.evaluate('!!document.querySelector("#editor-pane:not([hidden]) .cm-editor")'), 'the editor with the file');
    await cursorAtLine(6);
    await browser.type('mine ');
    await until(() => browser.evaluate('!!document.querySelector("#editor-head .dirty-dot")'), 'the unsaved mark');
    await ctrlS();
    const mine = 'ONE\ntwo\nthree\nfour\nfive\nmine six\n';
    await until(() => readFileSync(notes, 'utf8') === mine, 'the save');
    await browser.clickSelector('[data-action="show-chat"]');
    await showChanges();
    await until(() => browser.evaluate('document.querySelector(".changes .change-mark")?.getAttribute("aria-label") === "Edited by you"'), 'the Edited by you mark');

    // Revert all leaves it alone (no question: nothing else to revert) and says so.
    await browser.clickSelector('[data-action="revert-all"]');
    await until(async () => (await text()).includes('Kept 1 file(s) you edited: notes/hello.txt.'), 'the notice');
    assert.equal(readFileSync(notes, 'utf8'), mine);

    // Going back to before the request keeps it too, and the question names it first.
    await browser.clickSelector('[data-action="rewind"]');
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog")'), 'the confirmation dialog');
    assert.match(await text(), /Files you edited yourself are kept: notes\/hello\.txt\./);
    await browser.clickSelector('.modal-backdrop [data-action="dialog-action"][data-value="Go back"]');
    await until(async () => /Went back\..*Kept 1 file\(s\) you edited: notes\/hello\.txt\./.test(await text()), 'the notice');
    assert.equal(readFileSync(notes, 'utf8'), mine);

    // Revert offers only to undo the agent's part, which needs Git.
    if (spawnSync('git', ['--version']).status !== 0) return;
    await showChanges();
    await browser.clickSelector('.changes [data-action="revert"]');
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog")'), 'the Revert dialog');
    assert.match(await text(), /You edited notes\/hello\.txt after the agent\./);
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".modal-backdrop [data-action=dialog-action]")].map((b) => b.dataset.value)'), ["Undo only the agent's part"]);
    await browser.clickSelector('.modal-backdrop [data-action="dialog-action"]');
    await until(() => readFileSync(notes, 'utf8') === 'one\ntwo\nthree\nfour\nfive\nmine six\n', "only the agent's part undone");
  });

  /**
   * Parallel sessions: the app asks before every file write, does not ask for a build afterwards,
   * and knows a second folder. `extra` is added to the settings.
   */
  function twoFolders(extra = {}) {
    const other = mkdtempSync(path.join(tmpdir(), 'orka-desktop-other-'));
    const file = path.join(home, 'desktop', 'settings.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), permissionMode: 'ask', autoVerify: false, ...extra }));
    writeFileSync(path.join(home, 'desktop', 'state.json'), JSON.stringify({ global: { recentFolders: [path.resolve(work), path.resolve(other)] } }));
    return other;
  }

  /** Click the session list's "+" of a recent folder (once the list shows it). */
  const newSessionIn = async (folder) => {
    const button = `document.querySelector('.side-group-head [data-action="new-session"][data-folder="' + CSS.escape(${JSON.stringify(path.resolve(folder))}) + '"]')`;
    await until(() => browser.evaluate(`!!${button}`), `the + of ${path.basename(folder)}`);
    await browser.evaluate(`${button}.click()`);
  };

  /** Start a request in work that waits for the approval of a write to a.txt. */
  const waitingInWork = async () => {
    await browser.clickSelector('#input');
    await browser.type('Write a.txt');
    await browser.clickSelector('#send');
    await until(() => browser.evaluate('!!document.querySelector(".approval [data-action=approve]")'), 'the approval card');
  };

  it('runs two sessions at once and surfaces a background approval', async () => {
    const other = twoFolders();
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      script = [() => toolUse('toolu_a', 'write_file', { path: 'a.txt', content: 'from A\n' }), () => reply('B is done.'), () => reply('A is done.')];
      await waitingInWork();
      // An unsent text stays with its session.
      await browser.clickSelector('#input');
      await browser.type('draft for work');

      // A new session in the other folder; work's waits in the background.
      await newSessionIn(other);
      await until(async () => (await text()).includes('What should we build?'), 'an empty session in the other folder');
      assert.equal(await browser.evaluate('document.querySelector(".folder-btn span")?.textContent'), path.basename(other));
      assert.equal(await browser.evaluate('document.querySelector("#input").value'), '', "work's draft stays with work");
      await until(() => browser.evaluate('!!document.querySelector(".side-item.needs-approval [data-action=switch-session]")'), "work's row marked");
      assert.equal(await browser.evaluate('document.querySelector("#side-approvals button")?.getAttribute("aria-label")'), '1 session needs approval');
      assert.match(await browser.evaluate('document.title'), /^\(1\) /);

      // The other session runs while work still waits; nothing is written in work.
      await browser.clickSelector('#input');
      await browser.type('Say done');
      await browser.clickSelector('#send');
      await until(async () => (await text()).includes('B is done.'), "the other session's reply");
      assert.equal(existsSync(path.join(work, 'a.txt')), false);
      assert.equal(requests.length, 2);

      // The badge shows work again: its transcript, its approval card and its draft.
      await browser.clickSelector('#side-approvals button');
      await until(() => browser.evaluate('!!document.querySelector(".approval [data-action=approve]")'), "work's approval card again");
      assert.equal(await browser.evaluate('document.querySelector(".folder-btn span")?.textContent'), path.basename(work));
      assert.equal(await browser.evaluate('document.querySelector("#input").value'), 'draft for work');
      assert.ok(!(await text()).includes('B is done.'));
      await browser.clickSelector('.approval [data-action="approve"]');
      await until(async () => (await text()).includes('A is done.'), "work's reply");
      assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'from A\n');
      await until(() => browser.evaluate('!document.querySelector("#side-approvals button") && !document.querySelector(".side-item.running, .side-item.needs-approval")'), 'both sessions idle');
      assert.equal(await browser.evaluate('document.title'), 'Orka');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('shows the running session of a folder instead of starting a second one there', async () => {
    const other = twoFolders();
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      script = [() => toolUse('toolu_a', 'write_file', { path: 'a.txt', content: 'from A\n' })];
      await waitingInWork();
      await newSessionIn(other);
      await until(async () => (await text()).includes('What should we build?'), 'an empty session in the other folder');

      // "+" in work: its running session comes back, still waiting, and the app says why.
      await newSessionIn(work);
      await until(async () => (await text()).includes('A session is already running in'), 'the notice');
      assert.equal(await browser.evaluate('document.querySelector(".folder-btn span")?.textContent'), path.basename(work));
      assert.equal(await browser.evaluate('!!document.querySelector(".approval [data-action=approve]")'), true, 'still waiting for the approval');
      assert.equal(existsSync(path.join(work, 'a.txt')), false);
      assert.equal(requests.length, 1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a run over the limit of sessions running at once', async () => {
    const other = twoFolders({ 'sessions.maxRunning': 1 });
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      script = [() => toolUse('toolu_a', 'write_file', { path: 'a.txt', content: 'from A\n' }), () => reply('B ran anyway.')];
      await waitingInWork();
      await newSessionIn(other);
      await until(async () => (await text()).includes('What should we build?'), 'an empty session in the other folder');
      await browser.clickSelector('#input');
      await browser.type('Say done');
      await browser.clickSelector('#send');
      await until(async () => (await text()).includes('1 session is already running (the limit is 1, in Settings > Control).'), 'the refusal');
      await sleep(500);
      assert.equal(requests.length, 1, 'no request for the refused run');
      assert.ok(!(await text()).includes('B ran anyway.'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('only lets its own window in', async () => {
    const url = await launch();
    const { port } = new URL(url);
    const get = (pathname, headers = {}) =>
      new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => resolve(res.statusCode)).on('error', () => resolve(0)));
    assert.equal(await get('/'), 403, 'no session cookie');
    assert.equal(await get('/?t=wrong'), 403, 'wrong token');
    assert.equal(await get(new URL(url).pathname + new URL(url).search, { host: `evil.example:${port}` }), 421, 'DNS rebinding');
    assert.equal(await get(new URL(url).pathname + new URL(url).search), 303, 'the start URL sets the cookie');
    // Its code is visible on the browser's command line, so it works only once.
    assert.equal(await get(new URL(url).pathname + new URL(url).search), 403, 'the start URL is single-use');
  });

  it('keeps API keys protected by the operating system', { skip: process.platform !== 'win32' && 'DPAPI check is Windows-only' }, async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await post({ type: 'setApiKey', provider: 'openai' });
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog-input")'), 'the key dialog');
    assert.equal(await browser.evaluate('document.querySelector(".dialog-input").type'), 'password');
    await browser.clickSelector('.dialog-input');
    await browser.type('sk-test-desktop-1234567890');
    await browser.press('Enter');
    const keys = path.join(home, 'desktop', 'keys.json');
    // Encrypting starts PowerShell, which can be slow on a fresh CI machine.
    await until(() => existsSync(keys), 'the stored key', 120_000).catch(async (error) => {
      throw new Error(`${error.message}\n--- UI ---\n${(await text()).slice(-2000)}\n--- app ---\n${appOutput.slice(-2000)}`);
    });
    const blob = JSON.parse(readFileSync(keys, 'utf8'))['orka.apiKey.openai'];
    assert.match(blob, /^[0-9a-f]{100,}$/i, 'encrypted, not the key itself');
    assert.doesNotMatch(readFileSync(keys, 'utf8'), /sk-test-desktop/);

    // A new app instance reads it back (Windows decrypts it for this user only).
    browser.close();
    app.kill();
    browser = new HeadlessBrowser();
    const again = await launch();
    await browser.navigate(again);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await browser.clickSelector('[data-action="open-settings"]');
    await browser.clickSelector('[data-action="tab"][data-tab="providers"]');
    await until(async () => (await text()).includes('sk-tes••••7890'), 'the stored key hint', 120_000);
  });
});

describe('Orka desktop process', { skip: (process.platform !== 'win32' && 'Windows-only') || (!existsSync(APP) && 'build first (npm run build -w orka-desktop)') }, () => {
  it('sets up its own process at start: nothing it or its children start by bare name comes from the current folder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orka-lookup-'));
    try {
      // Loaded before the app; reports the variable as the app leaves it.
      const probe = path.join(dir, 'probe.cjs');
      writeFileSync(probe, "process.on('exit', () => process.stderr.write(`lookup=${process.env.NoDefaultCurrentDirectoryInExePath}\\n`));\n");
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
      const run = spawnSync(process.execPath, ['--require', probe, APP, '--version'], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /lookup=1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// orka-desktop.exe is a windowed program on Windows: started from Explorer it has no console, so
// the log file is where a failed start can be read.
describe('Orka desktop log', { skip: !existsSync(APP) && 'build first (npm run build -w orka-desktop)' }, () => {
  it('records a failed start in desktop.log', async () => {
    const busy = http.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const home = mkdtempSync(path.join(tmpdir(), 'orka-desktop-home-'));
    try {
      const app = spawn(process.execPath, [APP, '--no-window', '--port', String(busy.address().port)], {
        env: { ...process.env, ORKA_HOME: home, ORKA_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      app.stderr.on('data', (c) => (stderr += c));
      const code = await new Promise((r) => app.once('exit', r));
      assert.equal(code, 1, stderr);
      assert.match(stderr, /EADDRINUSE/);
      const log = readFileSync(path.join(home, 'desktop', 'desktop.log'), 'utf8');
      assert.match(log, /Orka Desktop \S+ starting/);
      assert.match(log, /Could not start: Error: listen EADDRINUSE/);
    } finally {
      busy.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
