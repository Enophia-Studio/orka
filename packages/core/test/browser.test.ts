import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { browserFor, closeBrowser, findBrowser, type ScreencastFrame } from '../src/browser/HeadlessBrowser';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { toClaudeMessages } from '../src/providers/ClaudeProvider';
import { toOpenAIMessages } from '../src/providers/OpenAIProvider';
import { browserTool, isLocalUrl } from '../src/tools/BrowserTools';
import type { ToolContext } from '../src/tools/Tool';
import type { ChatMessage } from '../src/types';
import { tempWorkspace } from './helpers';

const PAGE = `<!doctype html><title>Cart</title>
<h1 id="total">Total: 100</h1>
<input id="coupon" placeholder="coupon">
<button id="apply" onclick="document.getElementById('total').textContent = 'Total: ' + (document.getElementById('coupon').value === 'SAVE10' ? 90 : 100); console.error('coupon applied: ' + document.getElementById('coupon').value)">Apply</button>`;

describe('browser tool (real headless Chrome/Edge)', { skip: !findBrowser() && 'no Chrome/Edge/Chromium installed' }, () => {
  let server: http.Server;
  let base: string;
  const ws = tempWorkspace();
  const host = new NodeHost({ workspaceRoot: ws.root });
  const ctx: ToolContext = {
    callId: 'c',
    host,
    changes: new ChangeTracker(host),
    signal: new AbortController().signal,
    commandTimeoutMs: 30_000,
    plan: undefined,
    setPlan: () => {},
    onOutput: () => {},
  };

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}/`;
  });
  after(() => {
    closeBrowser(host);
    server.close();
    ws.cleanup();
  });

  it('opens a local page, clicks, types, reads the result and the console', async () => {
    const opened = await browserTool.execute({ action: 'open', url: base }, ctx);
    assert.match(opened.content, /^Page: Cart - http:\/\/localhost:\d+\/\nScreenshot \(1280x800\) attached\./);
    assert.equal(opened.images?.[0].mediaType, 'image/jpeg');
    assert.ok((opened.images?.[0].data.length ?? 0) > 1000, 'a real screenshot');
    assert.match(opened.thumb ?? '', /^data:image\/jpeg;base64,/);

    await browserTool.execute({ action: 'click', selector: '#coupon' }, ctx);
    await browserTool.execute({ action: 'type', text: 'SAVE10' }, ctx);
    const clicked = await browserTool.execute({ action: 'click', selector: '#apply' }, ctx);
    assert.match(clicked.content, /Console errors:\n\[error\] coupon applied: SAVE10/, 'console errors come with the screenshot');

    const read = await browserTool.execute({ action: 'read' }, ctx);
    assert.match(read.content, /Title: Cart[\s\S]*Total: 90/);

    const action = await browserTool.describe({ action: 'click', x: 10, y: 10 }, ctx);
    assert.deepEqual([action.category, action.risk], ['read', 'safe'], 'using a local page needs no approval');
    const external = await browserTool.describe({ action: 'open', url: 'https://example.com' }, ctx);
    assert.equal(external.category, 'network');
  });

  it('screenshots reach the model inside tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'browser', input: { action: 'screenshot' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'Page: Cart', images: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }] }] },
    ];
    const claude = toClaudeMessages(messages)[1].content as unknown as Array<{ content: Array<{ type: string }> }>;
    assert.deepEqual(claude[0].content.map((b) => b.type), ['text', 'image']);
    const openai = toOpenAIMessages('S', messages) as unknown as Array<{ role: string; content: unknown }>;
    assert.equal(openai[2].role, 'tool');
    assert.equal(openai[3].role, 'user', 'the image follows the tool message');
  });

  it('streams the page live, and while the user has taken it over the agent may only look', async () => {
    const browser = browserFor(host);
    await browserTool.execute({ action: 'open', url: base }, ctx);
    const frames: ScreencastFrame[] = [];
    let changes = 0;
    const off = browser.onChange(() => changes++);
    await browser.startScreencast((frame) => frames.push(frame));
    const deadline = Date.now() + 10_000;
    while (!frames.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(frames.length > 0, 'a frame arrives even for a page that does not repaint');
    assert.ok(Buffer.from(frames[0].data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');
    assert.equal(frames[0].width, 1280);

    browser.userControl = true;
    assert.ok(changes > 0, 'taking over is reported');
    await assert.rejects(browserTool.execute({ action: 'click', selector: '#apply' }, ctx), /The user has taken over the browser/);
    await assert.rejects(browserTool.execute({ action: 'open', url: base }, ctx), /taken over/);
    await assert.rejects(browserTool.execute({ action: 'close' }, ctx), /taken over/);
    const read = await browserTool.execute({ action: 'read' }, ctx);
    assert.match(read.content, /Title: Cart/, 'reading is still allowed');

    // The user's own clicks and keys reach the page.
    const box = await browser.evaluate('(() => { const r = document.getElementById("coupon").getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()');
    const [x, y, w, h] = box as number[];
    await browser.userMouse({ type: 'mousePressed', x: x + w / 2, y: y + h / 2, button: 'left', clickCount: 1 });
    await browser.userMouse({ type: 'mouseReleased', x: x + w / 2, y: y + h / 2, button: 'left', clickCount: 1 });
    for (const ch of 'SAVE10') {
      await browser.userKey({ type: 'keyDown', key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch });
      await browser.userKey({ type: 'keyUp', key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0) });
    }
    assert.equal(await browser.evaluate('document.getElementById("coupon").value'), 'SAVE10');

    browser.userControl = false;
    await browserTool.execute({ action: 'click', selector: '#apply' }, ctx);
    assert.match((await browser.text()).text, /Total: 90/, 'the agent has the page again');
    assert.equal(await browser.history('back'), true);
    browser.stopScreencast();
    assert.equal(browser.casting, false);
    off();
  });

  it("the user's drags reach the page with the button held, and a button still down is let go on give back", async () => {
    const browser = browserFor(host);
    await browserTool.execute({ action: 'open', url: base }, ctx);
    await browser.evaluate(
      `(() => { window.seen = []; for (const type of ['mousedown', 'mousemove', 'mouseup']) document.addEventListener(type, (e) => window.seen.push(type + ':' + e.buttons)); return true; })()`,
    );
    browser.userControl = true;
    await browser.userMouse({ type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 });
    await browser.userMouse({ type: 'mouseMoved', x: 140, y: 110, button: 'none' });
    await browser.userMouse({ type: 'mouseReleased', x: 140, y: 110, button: 'left', clickCount: 1 });
    await browser.userMouse({ type: 'mouseMoved', x: 150, y: 120, button: 'none' });
    assert.deepEqual(await browser.evaluate('window.seen'), ['mousedown:1', 'mousemove:1', 'mouseup:0', 'mousemove:0']);

    await browser.evaluate('window.seen = []');
    await browser.userMouse({ type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 });
    assert.equal(browser.heldButtons, 1);
    browser.userControl = false;
    const deadline = Date.now() + 5_000;
    while (browser.heldButtons && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await browser.evaluate('window.seen'), ['mousedown:1', 'mouseup:0']);
  });

  it('a browser that dies on its own ends the user control, and the agent can open a new one', async () => {
    const browser = browserFor(host);
    await browserTool.execute({ action: 'open', url: base }, ctx);
    browser.userControl = true;
    (browser as unknown as { proc: { kill(): void } }).proc.kill();
    const deadline = Date.now() + 10_000;
    while ((browser.userControl || browser.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(browser.userControl, false, 'the page is not held by a browser that is gone');
    assert.equal(browser.running, false);
    const opened = await browserTool.execute({ action: 'open', url: base }, ctx);
    assert.match(opened.content, /Cart/);
  });

  it('closing the browser ends the user control and keeps the same browser for the host', async () => {
    const browser = browserFor(host);
    await browserTool.execute({ action: 'open', url: base }, ctx);
    browser.userControl = true;
    closeBrowser(host);
    assert.equal(browser.userControl, false);
    assert.equal(browser.running, false);
    assert.equal(browserFor(host), browser, 'the agent and the Browser panel keep sharing it');
  });
});

describe('local pages', () => {
  it('counts this machine as local, and nothing else', () => {
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:3000', 'http://[::1]:8080/', 'http://app.localhost/', 'file:///C:/x.html', 'about:blank']) assert.ok(isLocalUrl(url), url);
    for (const url of ['https://example.com', 'http://localhost.example.com', 'http://10.0.0.1/', 'not a url']) assert.ok(!isLocalUrl(url), url);
  });
});
