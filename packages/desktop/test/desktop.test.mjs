// End-to-end tests of the desktop app (dist/orka-desktop.js): the real app runs with --no-window
// and a real headless Edge/Chrome drives its UI, while a fake Claude API scripts the model's turns.
// Everything else is real: the shared controller, the local server and its security checks,
// in-app dialogs, file writes, task history and (on Windows) DPAPI-protected API keys.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** A JavaScript string literal for code run in the page, safe inside <script> and with line separators. */
const jsString = (value) => JSON.stringify(String(value)).replace(/[<>/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
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
        // A step { status, headers, body } answers with that HTTP error (a 529 overloaded, a 429).
        if (next && typeof next === 'object') {
          res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers }).end(JSON.stringify(next.body));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // A step may answer later (a request that is still running meanwhile), or stream its answer itself.
        void Promise.resolve(next ? next(body) : reply('(script ended)')).then((answer) => (typeof answer === 'function' ? answer(res) : res.end(answer)));
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

  /**
   * Start the app without a window; resolves with its start URL. `node` is put before the app on
   * Node's command line; folder null: no folder (the welcome screen).
   */
  function launch(folder = work, { node = [], env = {} } = {}) {
    app = spawn(process.execPath, [...node, APP, ...(folder === null ? [] : [folder]), '--no-window'], {
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

  it('adds a streaming answer to the page block by block, keeping the blocks already shown', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    const fence = '```';
    const block = (n) => `Step **${n}** of the plan:\n\n${fence}js\nconsole.log(${n});\n${fence}\n\n`;
    const answer = Array.from({ length: 8 }, (_, i) => block(i + 1)).join('') + 'Done.';
    const chunks = answer.match(/[\s\S]{1,6}/g);
    let release;
    const halfway = new Promise((resolve) => (release = resolve));
    script = [
      () => async (res) => {
        res.write(sse([start('msg_stream'), ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]]));
        for (const [i, text] of chunks.entries()) {
          res.write(sse([['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]]));
          // Half the answer, then the test looks before the rest comes.
          if (i === Math.floor(chunks.length / 2)) await halfway;
          else await sleep(15);
        }
        res.end(
          sse([
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
            ['message_stop', { type: 'message_stop' }],
          ]),
        );
      },
    ];
    await browser.clickSelector('#input');
    await browser.type('Stream a plan');
    await browser.clickSelector('#send');
    const shown = (selector) => browser.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    await until(async () => (await shown('.msg.assistant.streaming .markdown pre')) >= 3, 'half the answer');
    // The code blocks shown so far are marked: a re-render (new nodes) would drop the mark.
    const seen = await browser.evaluate(`(() => {
      const pres = [...document.querySelectorAll('.msg.assistant.streaming .markdown pre')].slice(0, -1);
      pres.forEach((pre) => (pre.dataset.seen = '1'));
      return pres.length;
    })()`);
    release();
    await until(async () => (await shown('.msg.assistant.streaming .markdown pre')) >= 7, 'more of the answer');
    assert.equal(await shown('.msg.assistant.streaming .markdown pre[data-seen]'), seen, 'the finished blocks stay as they were shown');
    const oneCopyEach = 'document.querySelectorAll(".msg.assistant .markdown pre").length === document.querySelectorAll(".msg.assistant .markdown pre > .copy").length';
    assert.equal(await browser.evaluate(oneCopyEach), true, 'one Copy button per code block');
    // The finished answer is rendered whole, as before.
    await until(() => browser.evaluate('!document.body.classList.contains("busy")'), 'the end of the run');
    assert.equal(await shown('.msg.assistant .markdown pre'), 8);
    assert.equal(await shown('.msg.assistant .markdown pre[data-seen]'), 0);
    assert.equal(await browser.evaluate(oneCopyEach), true);
    assert.match(await text(), /Step 8 of the plan:[\s\S]*console\.log\(8\);[\s\S]*Done\./);
  });

  it('keeps the last keys typed when the window reloads or closes right after them', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    const origin = new URL(url).origin;
    const uiState = () => JSON.parse(readFileSync(path.join(home, 'desktop', 'ui-state.json'), 'utf8'));

    // Typed and reloaded at once: saving waits a moment after the keys, the reload does not lose them.
    await browser.clickSelector('#input');
    await browser.page('Input.insertText', { text: 'a draft typed just now' });
    await browser.navigate(`${origin}/`);
    await until(() => browser.evaluate('!!document.querySelector("#input")'), 'the chat UI after the reload');
    assert.equal(await browser.evaluate('document.querySelector("#input").value'), 'a draft typed just now');

    // Typed and closed at once: the draft is on disk for the next start.
    await browser.clickSelector('#input');
    await browser.page('Input.insertText', { text: ', and more' });
    await browser.navigate('about:blank');
    await until(() => existsSync(path.join(home, 'desktop', 'ui-state.json')) && uiState().draft === 'a draft typed just now, and more', 'the saved draft');
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

  it("picks a folder in Orka's own folder picker from the welcome screen", async () => {
    // A home of its own: the picker starts there when no folder is open and none is recent.
    const userHome = mkdtempSync(path.join(tmpdir(), 'orka-desktop-user-'));
    mkdirSync(path.join(userHome, 'Projects', 'Game'), { recursive: true });
    mkdirSync(path.join(userHome, 'Documents'));
    mkdirSync(path.join(userHome, '.hidden'));
    writeFileSync(path.join(userHome, 'Projects', 'readme.txt'), 'not a folder');
    try {
      const url = await launch(null, { env: { USERPROFILE: userHome, HOME: userHome } });
      await browser.navigate(url);
      await until(async () => (await text()).includes('Choose the project folder the agent works in.'), 'the welcome screen');
      await browser.clickSelector('.empty [data-action="open-folder"]');
      await until(() => browser.evaluate('document.querySelectorAll(".folder-picker .fp-item").length > 0'), 'the folder picker');
      assert.equal(await browser.evaluate('document.querySelector(".fp-path").value'), userHome, 'it starts at home');
      assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".fp-item .fp-name")].map((e) => e.textContent)'), ['Documents', 'Projects'], 'folders only, hidden ones left out');
      assert.ok((await browser.evaluate('[...document.querySelectorAll(".fp-place")].map((e) => e.textContent)')).includes('Documents'), 'Documents is a place');

      // Into Projects with the keyboard, then pick Game and open it.
      await browser.clickSelector('.fp-item[data-index="1"]');
      await browser.press('Enter');
      await until(async () => (await browser.evaluate('document.querySelector(".fp-path").value')) === path.join(userHome, 'Projects'), 'Projects');
      assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".fp-item .fp-name")].map((e) => e.textContent)'), ['Game']);
      await browser.clickSelector('.fp-item[data-index="0"]');
      await browser.clickSelector('[data-fp="open"]');
      await until(async () => (await browser.evaluate('document.querySelector(".folder-btn span")?.textContent')) === 'Game', 'the session in Game');
      assert.equal(await browser.evaluate('!!document.querySelector(".folder-picker")'), false, 'the picker closed');
      const state = JSON.parse(readFileSync(path.join(home, 'desktop', 'state.json'), 'utf8'));
      assert.equal(state.global.recentFolders[0], path.join(userHome, 'Projects', 'Game'));
    } finally {
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it('keeps the folder picker usable from the keyboard, shows a folder that is gone in the list, and selects a new hidden folder', async () => {
    const userHome = mkdtempSync(path.join(tmpdir(), 'orka-desktop-user-'));
    mkdirSync(path.join(userHome, 'Documents', 'Inner'), { recursive: true });
    mkdirSync(path.join(userHome, 'Projects'));
    const open = async () => {
      await browser.clickSelector('.empty [data-action="open-folder"]');
      await until(() => browser.evaluate('document.querySelectorAll(".folder-picker .fp-item").length > 0'), 'the folder picker');
    };
    const shown = () => browser.evaluate('document.querySelector(".fp-path")?.value');
    const names = () => browser.evaluate('[...document.querySelectorAll(".fp-item .fp-name")].map((e) => e.textContent)');
    const focusInPicker = () => browser.evaluate('document.querySelector(".folder-picker").contains(document.activeElement)');
    try {
      const url = await launch(null, { env: { USERPROFILE: userHome, HOME: userHome } });
      await browser.navigate(url);
      await until(async () => (await text()).includes('Choose the project folder the agent works in.'), 'the welcome screen');
      await open();

      // A place redraws the places: the focus stays in the picker, and a click on the note keeps it.
      const documents = await browser.evaluate(`[...document.querySelectorAll(".fp-place")].findIndex((e) => e.textContent === "Documents")`);
      await browser.clickSelector(`.fp-place[data-index="${documents}"]`);
      await until(async () => (await shown()) === path.join(userHome, 'Documents') && (await names()).includes('Inner'), 'Documents');
      assert.ok(await focusInPicker(), 'the focus is still in the picker');
      await browser.clickSelector('.fp-note');
      await browser.press('Escape');
      await until(async () => !(await browser.evaluate('!!document.querySelector(".folder-picker")')), 'Escape closes the picker');

      // A folder removed after it was listed: the list says so, with Go back; the path field has no error.
      await open();
      rmSync(path.join(userHome, 'Projects'), { recursive: true });
      await browser.clickSelector(`.fp-item[data-index="1"]`);
      await browser.press('Enter');
      await until(() => browser.evaluate('!!document.querySelector(".fp-list .fp-message")'), 'the error in the list');
      assert.equal(await browser.evaluate('document.querySelector(".fp-path-error").hidden'), true);
      assert.equal(await browser.evaluate('document.querySelector("[data-fp=open]").disabled'), true);
      assert.ok(await focusInPicker());
      await browser.clickSelector('.fp-message [data-fp="back"]');
      await until(async () => (await shown()) === userHome && JSON.stringify(await names()) === '["Documents"]', 'back at home');

      // A new folder whose name starts with a dot is shown and selected.
      await browser.clickSelector('[data-fp="new"]');
      await browser.type('.github');
      await browser.press('Enter');
      await until(() => browser.evaluate('document.querySelector(".fp-item.selected .fp-name")?.textContent === ".github"'), 'the new hidden folder selected');
      assert.equal(await browser.evaluate('document.querySelector(".fp-hidden-box").checked'), true);
      assert.ok(existsSync(path.join(userHome, '.github')));
    } finally {
      rmSync(userHome, { recursive: true, force: true });
    }
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

    // New session asks for the folder; Enter takes the open one.
    await browser.clickSelector('.side-new');
    await until(() => browser.evaluate('!!document.querySelector(".new-session-menu")'), 'the folder choice');
    await browser.press('Enter');
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

  it("loads the page in the UI's language, so the browser offers no translation, and follows a language change", async () => {
    const settings = path.join(home, 'desktop', 'settings.json');
    writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), language: 'tr' }));
    const url = await launch();
    await browser.navigate(url);
    await until(() => browser.evaluate('!!document.querySelector("#input") && document.querySelector("#input").placeholder !== ""'), 'the chat UI');
    // As served, before the chat UI's script runs.
    const served = await browser.evaluate(`fetch('/').then((r) => r.text())`);
    assert.match(served, /<html lang="tr" translate="no"/);
    assert.match(served, /<meta name="google" content="notranslate">/);
    assert.equal(await browser.evaluate('document.documentElement.lang'), 'tr');

    assert.equal(await post({ type: 'setSetting', key: 'language', value: 'en' }), 204);
    await until(async () => (await browser.evaluate('document.documentElement.lang')) === 'en', 'the English UI');
    assert.match(await browser.evaluate(`fetch('/').then((r) => r.text())`), /<html lang="en" translate="no"/, 'a reload loads it in English');
  });

  it("keeps the browser's own menu and page shortcuts out of the app, except in text fields and while nothing runs", async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    // True when the browser's default action was cancelled.
    const held = (target, event) => browser.evaluate(`!document.querySelector(${JSON.stringify(target)}).dispatchEvent(${event})`);
    const key = (init) => `new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}))`;
    const menu = `new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })`;

    assert.equal(await held('#transcript', menu), true, 'no browser menu on the conversation');
    assert.equal(await held('#input', menu), false, 'copy and paste in the message box');
    await browser.evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(document.body); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    assert.equal(await held('#transcript', menu), false, 'selected text can be copied');
    await browser.evaluate('getSelection().removeAllRanges()');

    for (const init of [{ key: 'p', ctrlKey: true }, { key: 's', ctrlKey: true }, { key: 'o', ctrlKey: true }, { key: 'ArrowLeft', altKey: true }, { key: 'ArrowRight', altKey: true }, { key: 'F7' }]) {
      if (process.platform === 'darwin') continue;
      assert.equal(await held('#input', key(init)), true, JSON.stringify(init));
    }
    assert.equal(await held('#input', key({ key: 'f', ctrlKey: true })), false, 'find stays');
    assert.equal(await held('#input', key({ key: 'a', ctrlKey: true })), false, 'select all stays');
    assert.equal(await held('#input', key({ key: 'ArrowLeft', ctrlKey: true })), false, 'moving by word stays');
    assert.equal(await held('body', `new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 3 })`), true, 'the mouse Back button');
    assert.equal(
      await browser.evaluate(`(() => { const d = new DataTransfer(); d.items.add(new File(['x'], 'a.txt')); return !document.querySelector('#transcript').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: d })); })()`),
      true,
      'a dropped file does not replace the app',
    );

    // Reloading only while no session runs.
    const reload = key({ key: 'F5' });
    assert.equal(await held('#input', reload), false, 'nothing runs: F5 reloads');
    let release;
    script = [() => new Promise((resolve) => (release = () => resolve(reply('Done waiting.'))))];
    await browser.clickSelector('#input');
    await browser.type('Wait a moment');
    await browser.clickSelector('#send');
    await until(() => browser.evaluate('document.documentElement.hasAttribute("data-running")'), 'the running mark');
    assert.equal(await held('#input', reload), true, 'F5 is held back while the session runs');
    assert.equal(await held('#input', key({ key: 'r', ctrlKey: true })), true, 'Ctrl+R too');
    await until(() => release, 'the request');
    release();
    await until(async () => (await text()).includes('Done waiting.'), 'the reply');
    await until(() => browser.evaluate('!document.documentElement.hasAttribute("data-running")'), 'the mark gone');
    assert.equal(await held('#input', reload), false, 'F5 reloads again');
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

  it('reviews the changes part by part with the keyboard and puts the comments into the message box, unsent', async () => {
    mkdirSync(path.join(work, 'src'));
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const before = `${lines.join('\n')}\n`;
    const after = `${lines.map((l, i) => (i === 1 ? 'LINE 2' : i === 17 ? 'LINE 18' : l)).join('\n')}\n`;
    writeFileSync(path.join(work, 'src', 'list.txt'), before);
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    script = [() => toolUse('toolu_w', 'write_file', { path: 'src/list.txt', content: after }), () => reply('Upper-cased two lines.'), () => reply('Nothing to build.')];
    await ask('Upper-case lines 2 and 18', 'Upper-cased two lines.');
    const sentBefore = requests.length;
    await showChanges();

    await browser.clickSelector('[data-action="review-start"]');
    await until(() => browser.evaluate('!!document.querySelector(".review .hunk-body")'), 'the first part');
    const panel = () => browser.evaluate('document.querySelector("#changes-panel").textContent');
    assert.match(await panel(), /File 1 of 1/);
    assert.match(await panel(), /Part 1 of 2/);
    const key = (k, init = {}) =>
      browser.evaluate(`(document.activeElement && document.querySelector('#changes-panel').contains(document.activeElement) ? document.activeElement : document.querySelector('.review')).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(init)} }))`);
    // k keeps the first part; the second one takes its place.
    await key('k');
    await until(async () => /Part 1 of 1/.test(await panel()), 'the next part');
    assert.match(await browser.evaluate('document.querySelector(".review .hunk-body").textContent'), /LINE 18/);
    // c opens a comment box; Ctrl+Enter adds the comment.
    await key('c');
    await until(() => browser.evaluate('document.activeElement?.id === "review-comment"'), 'the comment box');
    await browser.evaluate(`document.getElementById('review-comment').value = 'Keep line 18 as it was, it is a heading.'`);
    await key('Enter', { ctrlKey: true });
    await until(async () => /it is a heading/.test(await panel()), 'the comment');
    // r reverts the second part: the file keeps only the first change.
    await key('r');
    await until(async () => /Review finished/.test(await panel()), 'the summary');
    assert.equal(readFileSync(path.join(work, 'src', 'list.txt'), 'utf8'), after.replace('LINE 18', 'line 18'));
    assert.match(await panel(), /1 kept/);
    assert.match(await panel(), /1 reverted/);
    assert.match(await panel(), /1 comment/);

    await browser.evaluate('document.querySelector(".review .btn[data-action=review-feedback]").click()');
    const draft = await browser.evaluate('document.getElementById("input").value');
    assert.match(draft, /^Feedback on your changes:\n- src\/list\.txt \(@@ [^)]+\): Keep line 18 as it was, it is a heading\.\nI reverted: src\/list\.txt \(@@ [^)]+\)\.\nI kept 1 part\.$/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(requests.length, sentBefore, 'nothing was sent to the agent');
    assert.equal(await browser.evaluate('!!document.querySelector(".review")'), false, 'the review closed');
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

  it("leaves the request running on an Escape in an approval card's note field", async () => {
    const other = twoFolders();
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      script = [() => toolUse('toolu_a', 'write_file', { path: 'a.txt', content: 'from A\n' }), () => reply('A is done.')];
      await waitingInWork();
      assert.equal(await browser.evaluate('(() => { const f = document.querySelector(".approval input.feedback"); f.focus(); return document.activeElement === f; })()'), true);
      await browser.press('Escape');
      await sleep(400);
      assert.equal(await browser.evaluate('document.body.classList.contains("busy")'), true, 'still working');
      assert.equal(await browser.evaluate('!!document.querySelector(".approval [data-action=approve]")'), true, 'still waiting for the approval');
      await browser.clickSelector('.approval [data-action="approve"]');
      await until(async () => (await text()).includes('A is done.'), 'the reply after the approval');
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

  it('deletes a session through its … menu, of this folder and of another recent one, after the in-app question', async () => {
    const other = twoFolders();
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      // A narrow window, where the session list floats over the conversation.
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 700, height: 600, deviceScaleFactor: 1, mobile: false });
      const saved = async (prompt, answer) => {
        script = [() => reply(answer)];
        await browser.clickSelector('#input');
        await browser.type(prompt);
        await browser.clickSelector('#send');
        await until(async () => (await text()).includes(answer), 'the reply');
        return until(
          () => browser.evaluate(`[...document.querySelectorAll(".side-item")].find((e) => e.textContent.includes(${jsString(prompt)}))?.querySelector(".side-more")?.dataset.id`),
          `the row of ${prompt}`,
        );
      };
      /** Open a row's … menu and click Delete with the mouse, on its icon, where the session list lies below the menu. */
      const deleteThrough = async (id) => {
        const more = `.side-more[data-id="${id}"]`;
        await browser.clickSelector(more);
        await until(() => browser.evaluate('!!document.querySelector(".session-menu")'), 'the menu');
        const menu = await browser.evaluate(`(() => {
          const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
          const menu = document.querySelector(".session-menu");
          const items = [...menu.querySelectorAll(".menu-item")].map((item) => ({ ...box(item), label: box(item.querySelector("span")), action: item.dataset.action }));
          return { menu: box(menu), button: box(document.querySelector('${more}')), items, height: innerHeight };
        })()`);
        assert.ok(menu.menu.top >= menu.button.bottom || menu.menu.bottom <= menu.button.top, 'next to its button, not over it');
        assert.ok(menu.menu.bottom <= menu.height, 'inside the window');
        for (const item of menu.items) {
          assert.ok(item.top >= menu.menu.top && item.bottom <= menu.menu.bottom, `${item.action} inside the menu`);
          assert.ok(item.height >= 30, `${item.action} keeps its height (${item.height})`);
          assert.ok(item.label.top >= item.top && item.label.bottom <= item.bottom, `${item.action}: its text inside its highlight`);
        }
        const del = menu.items.find((i) => i.action === 'delete-session');
        await browser.click(del.left + 14, (del.top + del.bottom) / 2);
        await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog")'), 'the question');
        assert.match(await text(), /Delete this task from the history\?/);
        await browser.clickSelector('.modal-backdrop [data-action="dialog-action"]');
        await until(() => browser.evaluate(`!document.querySelector('${more}')`), 'the row gone');
      };
      const tasks = () => readdirSync(path.join(home, 'tasks'), { recursive: true }).filter((f) => path.dirname(f) !== '.' && path.basename(f) !== 'index.json');

      const first = await saved('Tidy up the readme', 'Readme tidied.');
      // A session in the other folder: work's is now one of another recent folder.
      await newSessionIn(other);
      await until(async () => (await text()).includes('What should we build?'), 'the other folder');
      const second = await saved('Count the files', 'Two files.');
      assert.equal(tasks().length, 2);
      await deleteThrough(second);
      await deleteThrough(first);
      assert.deepEqual(tasks(), [], 'both deleted from the history');
      await sleep(300);
      assert.doesNotMatch(await browser.evaluate('document.querySelector("#side-list").textContent'), /Tidy up the readme|Count the files/, 'and from the list');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('starts a new empty session in the folder chosen first: a recent one, the current one preselected, or another one', async () => {
    const other = twoFolders();
    const third = mkdtempSync(path.join(tmpdir(), 'orka-desktop-third-'));
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      const run = async (prompt, answer) => {
        script = [() => reply(answer)];
        await browser.clickSelector('#input');
        await browser.type(prompt);
        await browser.clickSelector('#send');
        await until(async () => (await text()).includes(answer), 'the reply');
      };
      const folderShown = () => browser.evaluate('document.querySelector(".folder-btn span")?.textContent');
      const chooser = () =>
        browser.evaluate(`(() => {
          const menu = document.querySelector(".session-menu.new-session-menu");
          if (!menu) return undefined;
          const items = [...menu.querySelectorAll(".menu-item")];
          return { items: items.map((i) => i.dataset.folder ?? i.dataset.action), checked: items.findIndex((i) => i.getAttribute("aria-checked") === "true"), focused: items.indexOf(document.activeElement) };
        })()`);
      const emptyIn = (folder) => until(async () => (await folderShown()) === path.basename(folder) && (await text()).includes('What should we build?'), `an empty session in ${path.basename(folder)}`);

      await run('Alpha one', 'Alpha done.');
      // New session asks for the folder first: the recent ones, the current one preselected, and Other folder….
      await browser.clickSelector('.side-new');
      let menu = await until(chooser, 'the folder choice');
      assert.deepEqual(menu.items, [path.resolve(work), path.resolve(other), 'new-session-other']);
      assert.equal(menu.checked, 0, 'the current folder is marked');
      assert.equal(menu.focused, 0, 'and has the focus');
      assert.ok((await text()).includes('Alpha done.'), 'nothing changed yet');
      // With the keyboard: down to the other folder, Enter.
      await browser.press('ArrowDown');
      assert.equal((await chooser()).focused, 1);
      await browser.press('Enter');
      await emptyIn(other);
      assert.equal(await chooser(), undefined, 'the choice closed');

      // Ctrl+Alt+N opens the same choice, now with this folder preselected; Enter starts a new empty session here.
      await run('Beta one', 'Beta done.');
      await browser.evaluate('document.activeElement.blur(), document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyN", key: "n", ctrlKey: true, altKey: true, bubbles: true })), true');
      menu = await until(chooser, 'the folder choice from the keyboard');
      assert.equal(menu.items[menu.checked], path.resolve(other));
      assert.equal(menu.focused, menu.checked);
      await browser.press('Enter');
      await until(async () => !(await text()).includes('Beta done.'), 'a new session in the same folder');
      await emptyIn(other);
      // Escape closes it without a new session.
      await browser.clickSelector('.side-new');
      await until(chooser, 'the folder choice');
      await browser.press('Escape');
      await until(async () => (await chooser()) === undefined, 'the choice closed by Escape');

      // Other folder…: Orka's folder picker, then a new empty session there.
      await browser.clickSelector('.side-new');
      await until(chooser, 'the folder choice');
      await browser.clickSelector('.new-session-menu [data-action="new-session-other"]');
      await until(() => browser.evaluate('!!document.querySelector(".folder-picker .fp-path")'), 'the folder picker');
      await browser.evaluate(`(() => { const f = document.querySelector(".fp-path"); f.focus(); f.value = ${jsString(third)}; return true; })()`);
      await browser.press('Enter');
      await until(async () => (await browser.evaluate('document.querySelector(".fp-path").value')) === third && (await browser.evaluate('!document.querySelector("[data-fp=open]").disabled')), 'the third folder shown');
      await browser.clickSelector('[data-fp="open"]');
      await emptyIn(third);
      const state = JSON.parse(readFileSync(path.join(home, 'desktop', 'state.json'), 'utf8'));
      assert.equal(state.global.recentFolders[0], path.resolve(third));
      assert.equal(requests.length, 2, 'no request was sent by any of it');
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(third, { recursive: true, force: true });
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

  // ---------------------------------------------------------------- accounts and CLIs (0.7)

  /** The core's fake ACP agent, run with this Node as a custom agent. */
  const fakeAgent = path.join(here, '..', '..', 'core', 'test', 'fixtures', 'fake-acp.mjs');
  const fakeAgentSettings = { 'agentClis.custom': [{ name: 'Fake', command: process.execPath, args: [fakeAgent] }] };

  function addSettings(extra) {
    const file = path.join(home, 'desktop', 'settings.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...extra }));
  }
  const settingsFile = () => JSON.parse(readFileSync(path.join(home, 'desktop', 'settings.json'), 'utf8'));

  /**
   * A stand-in for the Claude Code CLI that answers every command with a signed-in status (only
   * "auth status" reads it). Nothing real is installed, signed in or run.
   */
  function fakeClaude() {
    const dir = mkdtempSync(path.join(tmpdir(), 'orka-fake-cli-'));
    const status = '{"loggedIn":true,"email":"dev@example.test","authMethod":"claude.ai","subscriptionType":"pro"}';
    const file = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(file, process.platform === 'win32' ? `@echo ${status}\r\n` : `#!/bin/sh\necho '${status}'\n`, { mode: 0o755 });
    return { dir, file };
  }

  /** Every message the page sends is recorded in window.sent; `drop` types are not sent on (no terminal opens). */
  const recordMessages = (drop = []) =>
    browser.evaluate(`(() => {
      window.sent = [];
      const real = window.fetch;
      const drop = ${JSON.stringify(drop)};
      window.fetch = (url, init) => {
        if (url === '/message') {
          const message = JSON.parse(init.body);
          window.sent.push(message);
          if (drop.includes(message.type)) return Promise.resolve(new Response(null, { status: 204 }));
        }
        return real(url, init);
      };
    })()`);

  /**
   * An executable that runs FAKE_CLI_SCRIPT (with the arguments it was given) with this Node, in
   * place of a CLI such as claude: a script with a #! line, or on Windows a Node single executable
   * application (built once per Node version and kept in the temp folder), since CLIs are started
   * without a shell there.
   */
  async function fakeClaudeCli() {
    const loader = "require('node:module').createRequire(__filename)(process.env.FAKE_CLI_SCRIPT);\n";
    if (process.platform !== 'win32') {
      const file = path.join(home, 'fake-claude');
      writeFileSync(file, `#!${process.execPath}\n${loader}`, { mode: 0o755 });
      return file;
    }
    const exe = path.join(tmpdir(), `orka-test-fake-cli-${process.version}.exe`);
    if (existsSync(exe)) return exe;
    const dir = mkdtempSync(path.join(tmpdir(), 'orka-fake-cli-sea-'));
    try {
      writeFileSync(path.join(dir, 'main.js'), loader);
      writeFileSync(path.join(dir, 'sea.json'), JSON.stringify({ main: 'main.js', output: 'blob.bin', disableExperimentalSEAWarning: true }));
      spawnSync(process.execPath, ['--experimental-sea-config', 'sea.json'], { cwd: dir, stdio: 'ignore' });
      const partial = path.join(dir, 'fake.exe');
      copyFileSync(process.execPath, partial);
      const { inject } = require('postject');
      await inject(partial, 'NODE_SEA_BLOB', readFileSync(path.join(dir, 'blob.bin')), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
      renameSync(partial, exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return exe;
  }
  const fakeClaudeScript = path.join(here, '..', '..', 'core', 'test', 'fixtures', 'fake-claude.mjs');

  it('tries again after an overloaded API and a stream cut mid-answer, saying why it waits, and stops one command from its card', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    const cutOff = sse([
      start('msg_cut'),
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an answ' } }],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]);
    let finish;
    script = [
      { status: 529, headers: { 'retry-after': '2' }, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
      () => cutOff,
      () => toolUse('toolu_long', 'run_command', { command: 'node -e "setTimeout(() => {}, 60000)"' }),
      (body) => new Promise((resolve) => (finish = () => resolve(reply(`Seen: ${JSON.stringify(body.messages.at(-1).content).includes('Cancelled by the user') ? 'stopped' : 'not stopped'}`)))),
    ];
    await browser.clickSelector('#input');
    await browser.type('Run the long check');
    await browser.clickSelector('#send');
    // The 529 asked for 2 s: the status line counts it down.
    await until(() => browser.evaluate('document.querySelector(".session-head .phase-label")?.textContent ?? ""').then((t) => /Retrying in \d+s \(attempt 1\/3\)/.test(t)), 'the retry countdown', 10_000);
    // Then the command runs; its card offers its own Stop, and the status line names it.
    await until(() => browser.evaluate('!!document.querySelector(".tool-cancel")'), 'the Stop on the command', 20_000);
    assert.match(await browser.evaluate('document.querySelector(".session-head .phase-label")?.textContent ?? ""'), /Running run_command/);
    assert.ok(!(await text()).includes('Half an answ'), 'the cut-off text was dropped, not left above the retried answer');
    await browser.clickSelector('.tool-cancel');
    await until(() => requests.length === 4, 'the next turn after the stopped command', 15_000);
    assert.equal(await browser.evaluate('document.body.classList.contains("busy")'), true, 'the request goes on');
    finish();
    await until(async () => (await text()).includes('Seen: stopped'), 'the agent heard that the user stopped the command');
    assert.equal(requests.length, 4, 'one 529, one cut stream, the tool turn, the answer');
  });

  it('shows a Stop button that says so while the agent works, and Escape stops it too', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    let answer;
    script = [() => new Promise((resolve) => (answer = resolve))];
    await browser.clickSelector('#input');
    await browser.type('Take your time');
    await browser.clickSelector('#send');
    await until(() => browser.evaluate('document.querySelector("#send").getAttribute("aria-label") === "Stop"'), 'the Stop button');
    const button = await browser.evaluate(
      '(() => { const b = document.querySelector("#send"); const label = b.querySelector("span"); return { label: getComputedStyle(label).display !== "none" && label.textContent, title: b.title, width: b.getBoundingClientRect().width }; })()',
    );
    assert.equal(button.label, 'Stop', 'its name is shown, not just an icon');
    assert.equal(button.title, 'Stop (Esc)');
    assert.ok(button.width > 50, `wider than the round send button: ${button.width}`);

    // An Escape that closes a menu leaves the agent working.
    await browser.clickSelector('.model-btn');
    await until(() => browser.evaluate('!document.querySelector("#model-menu").hidden'), 'the model menu');
    await browser.press('Escape');
    await until(() => browser.evaluate('document.querySelector("#model-menu").hidden'), 'the menu closed');
    await sleep(300);
    assert.equal(await browser.evaluate('document.body.classList.contains("busy")'), true, 'still working');
    // In the message box, Escape stops it.
    await browser.evaluate('document.querySelector("#input").focus(), true');
    await browser.press('Escape');
    await until(() => browser.evaluate('!document.body.classList.contains("busy")'), 'the request stopped');
    assert.equal(await browser.evaluate('document.querySelector("#send").getAttribute("aria-label")'), 'Send');
    answer(reply('Too late.'));
  });

  it('keeps a Claude Code request running whatever is opened meanwhile, and shows it live again', async () => {
    const cli = await fakeClaudeCli();
    const gate = path.join(home, 'hold');
    const log = path.join(home, 'claude.log');
    const call = '<function_calls>\n<invoke name="list_directory">\n<parameter name="path">.</parameter>\n</invoke>\n</function_calls>';
    addSettings({ provider: 'claude-code', 'claudeCode.enabled': true, 'claudeCode.path': cli, permissionMode: 'autonomous' });
    const url = await launch(work, {
      env: { FAKE_CLI_SCRIPT: fakeClaudeScript, FAKE_CC_HOLD: gate, FAKE_CC_LOG: log, FAKE_CC_SCRIPT: JSON.stringify([`Looking first. ${call}`, 'Finished at last.']) },
    });
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await until(() => browser.evaluate('/Claude Code/.test(document.querySelector(".model-btn")?.textContent ?? "")'), 'Claude Code as the main agent', 60_000);
    await browser.clickSelector('#input');
    await browser.type('Take your time');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('Looking'), 'the first part of the answer', 60_000);
    const running = () => browser.evaluate('document.querySelector(".side-item.current")?.classList.contains("running")');
    const meanwhile = async (what, action) => {
      await action();
      await sleep(400);
      assert.equal(await running(), true, `still running after: ${what}`);
    };
    await meanwhile('Settings', () => browser.clickSelector('[data-action="open-settings"]'));
    await meanwhile('a setting changed', () => post({ type: 'setSetting', key: 'claudeCode.effort', value: 'high' }));
    await meanwhile('back to the chat', () => browser.clickSelector('[data-action="close-settings"]'));
    await meanwhile('New session in its folder', async () => {
      await browser.clickSelector('.side-new');
      await until(() => browser.evaluate('!!document.querySelector(".new-session-menu")'), 'the folder choice');
      await browser.press('Enter');
    });
    await until(async () => (await text()).includes('A session is already running in'), 'the notice');
    await meanwhile('the side panel', () => browser.evaluate('document.querySelector("[data-action=toggle-aside]").click(), true'));
    await meanwhile('Accounts', () => browser.evaluate('document.querySelector("[data-action=toggle-accounts]").click(), true'));
    await meanwhile('the folder picker', () => browser.evaluate('document.querySelector("[data-action=open-folder]").click(), true'));
    await meanwhile('Escape in the picker', () => browser.press('Escape'));
    await meanwhile('a reload', async () => {
      await browser.evaluate('location.reload(), true').catch(() => undefined);
      await sleep(1000);
      await until(async () => (await text()).includes('Looking'), 'the live answer after the reload');
    });
    assert.equal(await browser.evaluate('document.querySelector("#send").getAttribute("aria-label")'), 'Stop');
    writeFileSync(gate, '');
    await until(async () => (await text()).includes('Finishe'), 'the second turn');
    // A setting changed during the run applies from the next request: this one goes on in its own process.
    await meanwhile('Settings again', () => browser.clickSelector('[data-action="open-settings"]'));
    await meanwhile('another setting', () => post({ type: 'setSetting', key: 'claudeCode.effort', value: 'low' }));
    await browser.clickSelector('[data-action="close-settings"]');
    writeFileSync(gate, '');
    await until(async () => (await text()).includes('Finished at last.'), 'the answer');
    await until(async () => !(await running()), 'the run ended');
    const turns = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(turns.length, 2);
    assert.equal(new Set(turns.map((t) => t.pid)).size, 1, 'one Claude Code process for the whole request');
  });

  it('lists every agent CLI in the main agent picker, and picking one turns it on', async () => {
    addSettings(fakeAgentSettings);
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await browser.clickSelector('[data-action="open-settings"]');
    await browser.clickSelector('[data-action="tab"][data-tab="agents"]');
    const picker = 'document.querySelector(\'select[data-action="agent-provider"][data-agent="main"]\')';
    await until(() => browser.evaluate(`!!${picker}`), 'the main agent picker');
    const options = await browser.evaluate(`[...${picker}.querySelectorAll('optgroup option')].map((o) => o.value + ' ' + o.textContent)`);
    for (const id of ['agent:antigravity', 'agent:codex', 'agent:copilot', 'agent:cursor', 'agent:gemini']) {
      assert.ok(options.some((o) => o.startsWith(`${id} `)), `${id} is offered`);
    }
    assert.ok(options.includes('agent:custom:fake Fake (off)'), `the custom agent is offered while off: ${options.join(', ')}`);
    assert.equal(settingsFile()['agentClis.enabled'], undefined);

    await browser.evaluate(`(() => { const s = ${picker}; s.value = 'agent:custom:fake'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => settingsFile().provider === 'agent:custom:fake', 'the main agent saved');
    assert.deepEqual(settingsFile()['agentClis.enabled'], ['custom:fake'], 'and turned on');
    await until(() => browser.evaluate(`${picker}.selectedOptions[0]?.textContent === 'Fake'`), 'the picker without "(off)"');
  });

  it('shows a CLI account from its own status command, and signs in through the Add account popup', async () => {
    const cli = fakeClaude();
    try {
      addSettings({ 'claudeCode.path': cli.file });
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      await recordMessages(['loginAccount']);
      // Folding the footer open asks each CLI once; the fake answers signed in.
      await until(() => browser.evaluate('!!document.querySelector("[data-action=toggle-accounts]")'), 'the Accounts row');
      await browser.clickSelector('[data-action="toggle-accounts"]');
      await until(() => browser.evaluate('!!document.querySelector(".account-row[data-cli=claude-code] .account-dot.signed_in")'), 'Claude Code signed in', 60_000);
      assert.ok((await browser.evaluate('window.sent.map((m) => m.type)')).includes('checkAccounts'));

      await browser.clickSelector('.account-add');
      await until(() => browser.evaluate('!!document.querySelector(".add-account [data-action=add-account-pick][data-cli=claude-code]")'), 'the popup');
      assert.match(await browser.evaluate('document.querySelector(".add-account").textContent'), /dev@example\.test/, 'the account the CLI named');
      await browser.clickSelector('.add-account [data-action="add-account-pick"][data-cli="claude-code"]');
      await until(() => browser.evaluate('document.querySelector(".add-account .account-command")?.textContent'), 'the sign-in step');
      assert.equal(await browser.evaluate('document.querySelector(".add-account .account-command").textContent'), 'claude auth login', 'the vendor command, shown before anything runs');
      assert.ok(!(await browser.evaluate('window.sent.map((m) => m.type)')).includes('loginAccount'), 'nothing runs before the click');
      await browser.clickSelector('.add-account [data-action="account-login"]');
      await until(() => browser.evaluate('!document.querySelector(".add-account")'), 'the popup closed');
      const login = await browser.evaluate('window.sent.filter((m) => m.type === "loginAccount")');
      // Only ids go to the app (the default profile has none): never a command line.
      assert.deepEqual(login, [{ type: 'loginAccount', cli: 'claude-code' }]);
    } finally {
      rmSync(cli.dir, { recursive: true, force: true });
    }
  });

  it('adds an MCP server from the bundled catalog only after the consent dialog, and never shows its key again', async () => {
    const key = 'BSA-e2e-secret-key';
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await browser.clickSelector('[data-action="open-settings"]');
    await browser.clickSelector('[data-action="tab"][data-tab="mcp"]');
    await browser.clickSelector('[data-action="mcp-view"][data-view="catalog"]');
    await until(() => browser.evaluate('!!document.getElementById("mcp-catalog-search")'), 'the catalog');
    // Searching redraws only the list: the box keeps its focus.
    await browser.evaluate(`(() => { const box = document.getElementById('mcp-catalog-search'); box.focus(); box.value = 'brave'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".catalog-row")].map((r) => r.dataset.entry)'), ['brave-search']);
    assert.equal(await browser.evaluate('document.activeElement.id'), 'mcp-catalog-search');

    const fill = async () => {
      await browser.clickSelector('[data-action="catalog-add"][data-id="brave-search"]');
      await until(() => browser.evaluate('!!document.querySelector(".catalog-form [data-catalog-field=BRAVE_API_KEY]")'), 'the Add form');
      assert.equal(await browser.evaluate('document.querySelector("[data-catalog-field=BRAVE_API_KEY]").type'), 'password');
      await browser.evaluate(`document.querySelector('[data-catalog-field=BRAVE_API_KEY]').value = ${JSON.stringify(key)}`);
      await browser.clickSelector('[data-action="catalog-form-submit"]');
      await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog[role=alertdialog]")'), 'the consent dialog');
    };
    await fill();
    const consent = await browser.evaluate('document.querySelector(".modal-backdrop .dialog").textContent');
    assert.match(consent, /npx -y @brave\/brave-search-mcp-server --transport stdio/, 'the exact command');
    assert.match(consent, /downloads this third-party server/);
    assert.ok(!consent.includes(key), 'the key is not in the dialog');
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-catalog-field]").length'), 0, 'the form and its values are gone');
    // Cancel: nothing written.
    await browser.clickSelector('.modal-backdrop [data-action="dialog-cancel"]');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settingsFile().mcpServers, undefined);

    await fill();
    await browser.clickSelector('.modal-backdrop [data-action="dialog-action"]');
    await until(() => settingsFile().mcpServers?.['brave-search'], 'the server in the settings');
    assert.deepEqual(settingsFile().mcpServers['brave-search'], {
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
      env: { BRAVE_API_KEY: key },
    });
    await until(() => browser.evaluate('!!document.querySelector(".catalog-row[data-entry=brave-search] .pill.ok")'), 'shown as added');
    assert.ok(!(await browser.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(key)})`)), 'the key is never on the page');
  });

  it("limits an MCP server's tools from Settings → MCP → Limits, and the next request gets only the allowed ones", async () => {
    const fakeMcp = path.join(here, '..', '..', 'core', 'test', 'fixtures', 'fake-mcp.mjs');
    addSettings({ mcpServers: { unity: { command: process.execPath, args: [fakeMcp] } } });
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    script = [() => reply('Hello.')];
    await ask('hi', 'Hello.');
    const toolNames = (i) => requests[i].body.tools.map((tool) => tool.name).filter((name) => name.startsWith('mcp__'));
    assert.deepEqual(toolNames(0), ['mcp__unity__get_scene', 'mcp__unity__delete_object']);

    await browser.clickSelector('[data-action="open-settings"]');
    await browser.clickSelector('[data-action="tab"][data-tab="mcp"]');
    await until(() => browser.evaluate('!!document.querySelector(".mcp-limits [data-setting=\\"mcp.maxTools\\"]")'), 'the global limits');
    await browser.clickSelector('[data-action="mcp-limits"][data-name="unity"]');
    await until(() => browser.evaluate('!!document.querySelector("[data-mcp-tool=delete_object]")'), "the server's tools");
    await browser.evaluate(`(() => {
      document.querySelector('[data-mcp-tool=delete_object]').checked = false;
      document.querySelector('[data-mcp-limit=maxResultChars]').value = '2000';
    })()`);
    await browser.clickSelector('[data-action="mcp-limits-save"][data-name="unity"]');
    await until(() => settingsFile()['mcp.serverLimits']?.unity, 'the limits in the settings');
    assert.deepEqual(settingsFile()['mcp.serverLimits'], { unity: { maxResultChars: 2000, allowedTools: ['get_scene'] } });
    await until(async () => /1 of 2 tools/.test(await text()), 'the tool count');

    // A task keeps the tools it started with: the limits apply from the next one.
    await browser.clickSelector('[data-action="close-settings"]');
    await newSessionIn(work);
    await until(async () => (await text()).includes('What should we build?'), 'a new session');
    script = [() => reply('Hello again.')];
    await ask('hi again', 'Hello again.');
    assert.deepEqual(toolNames(1), ['mcp__unity__get_scene']);
  });

  it('adds a skill from the gallery to <Orka home>/skills, previews one, asks before a download, and removes it after asking', async () => {
    const url = await launch();
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    await browser.clickSelector('[data-action="open-settings"]');
    await browser.clickSelector('[data-action="tab"][data-tab="skills"]');
    await browser.clickSelector('[data-action="skills-view"][data-view="gallery"]');
    await until(() => browser.evaluate('!!document.getElementById("skill-gallery-search")'), 'the gallery');
    // Searching redraws only the list: the box keeps its focus.
    await browser.evaluate(`(() => { const box = document.getElementById('skill-gallery-search'); box.focus(); box.value = 'godot'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".catalog-row")].map((r) => r.dataset.entry)'), ['godot', 'godot-gdscript-patterns']);
    assert.equal(await browser.evaluate('document.activeElement.id'), 'skill-gallery-search');

    // The preview shows the skill's text as it comes with Orka.
    await browser.clickSelector('[data-action="gallery-preview"][data-id="godot"]');
    await until(() => browser.evaluate('(document.querySelector(".skill-preview-text") || {}).textContent || ""').then((t) => t.includes('# Godot')), 'the preview');
    await browser.clickSelector('.skill-preview .btn[data-action="gallery-preview-close"]');

    // Enable copies it into the user's skills folder, with its licence.
    const dir = path.join(home, 'skills', 'godot');
    await browser.clickSelector('[data-action="gallery-install"][data-id="godot"]');
    await until(() => existsSync(path.join(dir, '.orka-gallery.json')), 'the skill in the skills folder');
    for (const file of ['SKILL.md', 'LICENSE', 'NOTICE']) assert.ok(existsSync(path.join(dir, file)), file);
    await until(() => browser.evaluate('!!document.querySelector(".catalog-row[data-entry=godot] .pill.ok")'), 'shown as installed');

    // A download asks first, with the exact URLs; Cancel fetches nothing.
    await browser.evaluate(`(() => { const box = document.getElementById('skill-gallery-search'); box.value = 'ugui'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await browser.clickSelector('[data-action="gallery-install"][data-id="ui-ugui"]');
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog[role=alertdialog]")'), 'the consent dialog');
    const consent = await browser.evaluate('document.querySelector(".modal-backdrop .dialog").textContent');
    assert.match(consent, /https:\/\/raw\.githubusercontent\.com\/Unity-Technologies\/skills\/60f95e6d4beaeacf4dfdff7829ec9b35008a0be0\/skills\/ui-ugui\/SKILL\.md/);
    assert.match(consent, /Unity Companion License/);
    await browser.clickSelector('.modal-backdrop [data-action="dialog-cancel"]');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!existsSync(path.join(home, 'skills', 'ui-ugui')));

    // My skills shows where it came from; Remove asks, then deletes the folder.
    await browser.clickSelector('[data-action="skills-view"][data-view="mine"]');
    await until(() => browser.evaluate('!!document.querySelector("[data-action=gallery-remove][data-name=godot]")'), 'the installed skill in My skills');
    await browser.clickSelector('[data-action="gallery-remove"][data-name="godot"]');
    await until(() => browser.evaluate('!!document.querySelector(".modal-backdrop .dialog[role=alertdialog]")'), 'the remove dialog');
    await browser.clickSelector('.modal-backdrop [data-action="dialog-action"]');
    await until(() => !existsSync(dir), 'the folder removed');
  });

  it("offers the agent's own model and thought level in the message box menu, and shows how full the context is", async () => {
    const log = path.join(home, 'fake-acp.log');
    addSettings({ ...fakeAgentSettings, provider: 'agent:custom:fake', 'agentClis.enabled': ['custom:fake'] });
    const url = await launch(work, {
      env: {
        FAKE_ACP_OPTIONS: '1',
        FAKE_ACP_LOG: log,
        FAKE_ACP_SCRIPT: JSON.stringify([
          [{ usage: { used: 3000, size: 12000 } }, { chunk: 'Hello from the fake agent.' }, { stop: 'end_turn' }],
          [{ chunk: 'Second answer.' }, { stop: 'end_turn' }],
        ]),
      },
    });
    await browser.navigate(url);
    await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
    assert.equal(await browser.evaluate('document.querySelector("#context-ring").hidden'), true, 'no gauge before the agent reports one');
    await browser.clickSelector('.model-btn');
    await until(() => browser.evaluate('!document.querySelector("#model-menu").hidden'), 'the menu');
    assert.match(await browser.evaluate('document.querySelector("#model-menu").textContent'), /Set in the agent/, 'no choices before its first session');
    await browser.clickSelector('.model-btn');

    await browser.clickSelector('#input');
    await browser.type('Say hello');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('Hello from the fake agent.'), 'the reply');
    await until(() => browser.evaluate('!document.querySelector("#context-ring").hidden'), 'the gauge');
    assert.match(await browser.evaluate('document.querySelector("#context-ring").title'), /^Context: 25% full/);

    await browser.clickSelector('.model-btn');
    await until(() => browser.evaluate('!!document.querySelector("#model-menu [data-action=session-option][data-value=pro]")'), "the agent's models");
    const menu = await browser.evaluate('document.querySelector("#model-menu").textContent');
    assert.match(menu, /Pro model/);
    assert.match(menu, /High/, 'its thought level');
    assert.doesNotMatch(menu, /Yolo/, "never the agent's own modes");
    await browser.clickSelector('#model-menu [data-action="session-option"][data-value="pro"]');
    await until(() => browser.evaluate('document.querySelector("#model-menu [data-value=pro]")?.getAttribute("aria-checked") === "true"'), 'the pick');
    // A pick from the keyboard keeps the focus in the menu after it is drawn again (a new value: the
    // app sends the config only when it changed).
    await browser.evaluate(
      'window.oldItem = document.querySelector("#model-menu button"); const b = document.querySelector("#model-menu [data-action=session-option][data-value=high]"); b.focus(); b.click(); true',
    );
    await until(() => browser.evaluate('!window.oldItem.isConnected'), 'the menu drawn again');
    assert.equal(await browser.evaluate('!!document.activeElement.closest("#model-menu") && document.activeElement.getAttribute("aria-checked")'), 'true');
    // Escape closes it even with the focus outside it.
    await browser.evaluate('document.activeElement.blur(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
    await until(() => browser.evaluate('document.querySelector("#model-menu").hidden'), 'the menu closed by Escape');

    // Sent to the agent before the next prompt, never while one runs.
    await browser.clickSelector('#input');
    await browser.type('Again');
    await browser.clickSelector('#send');
    await until(async () => (await text()).includes('Second answer.'), 'the second reply');
    const methods = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      methods.some((m) => JSON.stringify(m).includes('session/set_config_option') && JSON.stringify(m).includes('"pro"')),
      'the model choice reached the agent',
    );
  });

  it("shows the agent's browser live in the Browser tab, and hands the page to the user on Take over", async () => {
    // A local dev server whose page reports what reaches it.
    const hits = [];
    const page = `<!doctype html><title>Local app</title><body style="margin:0">
<button id="all" style="position:fixed;inset:0;width:100%;height:100%;font-size:40px">Local app</button>
<script>
  const report = (what) => fetch('/hit?' + new URLSearchParams(what));
  document.getElementById('all').addEventListener('mousedown', (e) => report({ kind: 'click', x: e.clientX, y: e.clientY }));
  addEventListener('keydown', (e) => report({ kind: 'key', key: e.key }));
</script>`;
    const dev = http.createServer((req, res) => {
      if (req.url.startsWith('/hit?')) hits.push(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
      res.writeHead(200, { 'content-type': 'text/html' }).end(req.url.startsWith('/hit?') ? '' : page);
    });
    await new Promise((r) => dev.listen(0, '127.0.0.1', r));
    const devUrl = `http://localhost:${dev.address().port}/`;
    try {
      const url = await launch();
      await browser.navigate(url);
      await until(async () => (await text()).includes('What should we build?'), 'the chat UI');
      await browser.evaluate(`window.cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.cspViolations.push(e.violatedDirective + ' ' + e.blockedURI))`);
      await browser.clickSelector('.topbar .aside-btn');
      await until(() => browser.evaluate('!!document.querySelector("#aside-tab-browser")'), 'the Browser tab');
      await browser.clickSelector('#aside-tab-browser');
      await until(() => browser.evaluate('!!document.querySelector("#browser-panel:not([hidden]) #browser-url")'), 'the Browser panel');
      assert.match(await browser.evaluate('document.querySelector("#browser-empty").textContent'), /No page is open/);
      assert.equal(await browser.evaluate('document.querySelector("[data-action=browser-control]").disabled'), true, 'nothing to take over yet');

      // The user types the address: it opens without an approval, and its frames come in.
      await browser.evaluate(`document.getElementById('browser-url').value = ${JSON.stringify(devUrl.replace('http://', ''))}`);
      await browser.clickSelector('[data-action="browser-go"]');
      await until(() => browser.evaluate('(() => { const f = document.getElementById("browser-frame"); return !f.hidden && f.src.startsWith("data:image/jpeg;base64,") && f.naturalWidth === 1280; })()'), 'a frame of the page', 45_000);
      assert.equal(await browser.evaluate('document.getElementById("browser-url").value'), devUrl);

      // Take over: a click on the frame's middle reaches the middle of the page.
      await browser.clickSelector('[data-action="browser-control"]');
      await until(() => browser.evaluate('document.querySelector("[data-action=browser-control]").getAttribute("aria-pressed") === "true"'), 'taken over');
      assert.equal(await browser.evaluate('document.activeElement.id'), 'browser-screen', 'the page has the keyboard');
      await browser.clickSelector('#browser-frame');
      await until(() => hits.find((h) => h.kind === 'click'), 'the click on the page');
      const click = hits.find((h) => h.kind === 'click');
      assert.ok(Math.abs(Number(click.x) - 640) <= 12 && Math.abs(Number(click.y) - 400) <= 12, `scaled to the page: ${click.x},${click.y}`);
      await browser.press('Enter');
      await until(() => hits.find((h) => h.kind === 'key' && h.key === 'Enter'), 'the key on the page');

      // Meanwhile the agent may look, not act: its click is refused with a clear message.
      script = [() => toolUse('toolu_b', 'browser', { action: 'click', x: 10, y: 10 }), () => reply('Waiting for you.')];
      await browser.clickSelector('#input');
      await browser.type('Click the button');
      await browser.clickSelector('#send');
      await until(async () => (await text()).includes('Waiting for you.'), 'the reply');
      assert.match(JSON.stringify(requests.at(-1).body.messages), /The user has taken over the browser/);
      assert.equal(hits.filter((h) => h.kind === 'click').length, 1, "the agent's click never reached the page");

      await browser.clickSelector('[data-action="browser-control"]');
      await until(() => browser.evaluate('document.querySelector("[data-action=browser-control]").getAttribute("aria-pressed") === "false"'), 'given back');
      assert.deepEqual(await browser.evaluate('window.cspViolations'), []);
    } finally {
      dev.close();
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
