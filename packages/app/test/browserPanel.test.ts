import type { ScreencastFrame, UserKeyEvent, UserMouseEvent } from '@orka/core';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { BrowserPanel, type PanelBrowser, printedServers, probePort, toBrowserInput, userUrl } from '../src/browserPanel';

/** A stand-in for the session's headless browser: records what the panel asks of it. */
class FakeBrowser implements PanelBrowser {
  running = false;
  url = 'about:blank';
  private held = false;
  readonly viewport = { width: 1280, height: 800 };
  readonly mouse: UserMouseEvent[] = [];
  readonly keys: UserKeyEvent[] = [];
  readonly opened: string[] = [];
  readonly history: PanelBrowser['history'] = async (action) => {
    this.historyCalls.push(action);
    return true;
  };
  readonly historyCalls: string[] = [];
  onFrame?: (frame: ScreencastFrame) => void;
  frame(frame: ScreencastFrame): void {
    assert.ok(this.onFrame, 'the screencast runs');
    this.onFrame(frame);
  }
  private listeners = new Set<() => void>();

  get userControl(): boolean {
    return this.held;
  }
  set userControl(value: boolean) {
    this.held = value;
    this.emit();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
  async startScreencast(onFrame: (frame: ScreencastFrame) => void): Promise<void> {
    this.onFrame = onFrame;
  }
  stopScreencast(): void {
    this.onFrame = undefined;
  }
  async navigate(url: string): Promise<void> {
    this.opened.push(url);
    this.running = true;
    this.url = url;
    this.emit();
  }
  async userMouse(event: UserMouseEvent): Promise<void> {
    this.mouse.push(event);
  }
  async userKey(event: UserKeyEvent): Promise<void> {
    this.keys.push(event);
  }
  async navigation(): Promise<{ canBack: boolean; canForward: boolean }> {
    return { canBack: this.opened.length > 1, canForward: false };
  }
}

function panel(options: { active?: () => boolean; processes?: Array<{ name: string; output: string; running: boolean }>; open?: number[] } = {}) {
  const browser = new FakeBrowser();
  const posts: Array<{ type: string; [k: string]: any }> = [];
  const p = new BrowserPanel({
    browser,
    post: (m) => posts.push(m),
    active: options.active ?? (() => true),
    processes: () => options.processes ?? [],
    probe: async (port) => (options.open ?? []).includes(port),
  });
  const last = (type: string) => [...posts].reverse().find((m) => m.type === type);
  return { browser, posts, panel: p, last };
}

describe('Browser panel: addresses the user types', () => {
  it('opens http(s) only, and gives a bare port or local host a scheme', () => {
    assert.equal(userUrl('5173'), 'http://localhost:5173/');
    assert.equal(userUrl(':3000/app'), 'http://localhost:3000/app');
    assert.equal(userUrl('localhost:8080'), 'http://localhost:8080/');
    assert.equal(userUrl('127.0.0.1:4200/x?y=1'), 'http://127.0.0.1:4200/x?y=1');
    assert.equal(userUrl('[::1]:5000'), 'http://[::1]:5000/');
    assert.equal(userUrl('app.localhost'), 'http://app.localhost/');
    assert.equal(userUrl('example.com'), 'https://example.com/');
    assert.equal(userUrl('http://example.com/a'), 'http://example.com/a');
    for (const bad of ['', '   ', 'javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,hi', 'chrome://settings', 'ftp://x', 'a b', 'x'.repeat(3000)]) {
      assert.equal(userUrl(bad), undefined, bad);
    }
  });
});

describe('Browser panel: the user input to a taken-over page', () => {
  const viewport = { width: 1280, height: 800 };
  it("scales the shown frame's point to the page's pixels and clamps it", () => {
    assert.deepEqual(toBrowserInput({ kind: 'mouse', action: 'down', x: 0.5, y: 0.25, button: 0, clicks: 2, mods: 2 }, viewport), {
      mouse: { type: 'mousePressed', x: 640, y: 200, button: 'left', clickCount: 2, modifiers: 2 },
    });
    assert.deepEqual(toBrowserInput({ kind: 'mouse', action: 'move', x: 7, y: -3 }, viewport), {
      mouse: { type: 'mouseMoved', x: 1279, y: 0, button: 'none', clickCount: 0, modifiers: 0 },
    });
    assert.deepEqual(toBrowserInput({ kind: 'mouse', action: 'up', x: 1, y: 1, button: 2 }, viewport), {
      mouse: { type: 'mouseReleased', x: 1279, y: 799, button: 'right', clickCount: 1, modifiers: 0 },
    });
    assert.deepEqual(toBrowserInput({ kind: 'wheel', x: 0, y: 0, dx: 0, dy: 1e9 }, viewport), { mouse: { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: 5000, modifiers: 0 } });
  });
  it('passes a key with its one character, and drops anything malformed', () => {
    assert.deepEqual(toBrowserInput({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' }, viewport), {
      key: { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 },
    });
    // A long text is not a key press (no pasting through the key path).
    assert.deepEqual(toBrowserInput({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'pasted text' }, viewport), {
      key: { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 },
    });
    for (const bad of [null, {}, { kind: 'mouse', action: 'drag', x: 0, y: 0 }, { kind: 'key', action: 'down', key: '', code: '', keyCode: 0 }, { kind: 'key', action: 'press', key: 'a', code: 'KeyA', keyCode: 65 }, { kind: 'other' }]) {
      assert.equal(toBrowserInput(bad as never, viewport), undefined, JSON.stringify(bad));
    }
  });
});

describe('Browser panel: the session browser, live', () => {
  it('streams frames only while it shows and the page shows this session', async () => {
    let active = true;
    const { browser, posts, panel: p } = panel({ active: () => active });
    await p.handle({ type: 'browserView', visible: true });
    assert.ok(browser.onFrame, 'the screencast started');
    browser.frame({ data: 'AAAA', width: 1280, height: 800 });
    assert.deepEqual(posts.filter((m) => m.type === 'browserFrame'), [{ type: 'browserFrame', data: 'AAAA', width: 1280, height: 800 }]);
    await p.handle({ type: 'browserView', visible: false });
    assert.equal(browser.onFrame, undefined, 'hidden: no more frames');

    await p.handle({ type: 'browserView', visible: true });
    active = false;
    browser.frame({ data: 'BBBB', width: 1280, height: 800 });
    assert.equal(posts.filter((m) => m.type === 'browserFrame').length, 1, 'another session shown: the frame is not sent');
    assert.equal(browser.onFrame, undefined, 'and the screencast stops');
  });

  it("opens the user's address without asking, refuses other schemes, and reports the state", async () => {
    const { browser, panel: p, last } = panel();
    await p.handle({ type: 'browserOpen', url: 'javascript:alert(1)' });
    assert.deepEqual(browser.opened, []);
    assert.match(last('browserState')!.state.error, /Only http and https/);
    await p.handle({ type: 'browserOpen', url: '5173' });
    assert.deepEqual(browser.opened, ['http://localhost:5173/']);
    const state = last('browserState')!.state;
    assert.equal(state.running, true);
    assert.equal(state.url, 'http://localhost:5173/');
    assert.equal(state.error, undefined);
    assert.equal(state.loading, undefined);
    await p.handle({ type: 'browserOpen', url: 'http://169.254.169.254/latest/meta-data' });
    assert.equal(browser.opened.length, 1, 'cloud metadata stays blocked, typed or not');
    assert.match(last('browserState')!.state.error, /metadata/);
    await p.handle({ type: 'browserNav', action: 'back' });
    await p.handle({ type: 'browserNav', action: 'evil' as never });
    assert.deepEqual(browser.historyCalls, ['back']);
  });

  it('hands the input to the page only while the user has taken it over', async () => {
    const { browser, panel: p, last } = panel();
    const click = { type: 'browserInput', input: { kind: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 0, clicks: 1 } } as const;
    await p.handle({ type: 'browserControl', take: true });
    assert.equal(browser.userControl, false, 'nothing open: nothing to take over');
    await p.handle(click);
    assert.equal(browser.mouse.length, 0);

    await p.handle({ type: 'browserOpen', url: 'localhost:3000' });
    await p.handle({ type: 'browserControl', take: true });
    assert.equal(browser.userControl, true);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(last('browserState')!.state.control, true);
    await p.handle(click);
    await p.handle({ type: 'browserInput', input: { kind: 'key', action: 'down', key: 'x', code: 'KeyX', keyCode: 88, text: 'x' } });
    assert.deepEqual(browser.mouse, [{ type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1, modifiers: 0 }]);
    assert.equal(browser.keys.length, 1);

    await p.handle({ type: 'browserControl', take: false });
    await p.handle(click);
    assert.equal(browser.mouse.length, 1, 'given back: the input is dropped');
  });

  it('gives the page back when the session goes out of sight or away', async () => {
    const { browser, panel: p, posts } = panel();
    await p.handle({ type: 'browserOpen', url: 'localhost:3000' });
    await p.handle({ type: 'browserView', visible: true });
    await p.handle({ type: 'browserControl', take: true });
    p.hide();
    assert.equal(browser.userControl, false);
    assert.equal(browser.onFrame, undefined);
    await p.handle({ type: 'browserControl', take: true });
    p.dispose();
    assert.equal(browser.userControl, false);
    const count = posts.length;
    await p.handle({ type: 'browserOpen', url: 'localhost:4000' });
    browser.emit();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(posts.length, count, 'a closed session posts nothing');
  });

  it('offers the dev servers its processes printed, then common ports that answer', async () => {
    const output = '\u001b[32m  VITE v5  ready\u001b[0m\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://0.0.0.0:5173/\nalso http://127.0.0.1:9229/json, and https://example.com\n';
    assert.deepEqual(printedServers([{ name: 'vite', output, running: true }]), [
      { url: 'http://localhost:5173/', process: 'vite' },
      { url: 'http://127.0.0.1:9229/json', process: 'vite' },
    ]);
    assert.deepEqual(printedServers([{ name: 'old', output, running: false }]), [], 'a stopped process serves nothing');
    const { panel: p, last } = panel({ processes: [{ name: 'vite', output: 'Local: http://localhost:5173/', running: true }], open: [5173, 8080] });
    await p.handle({ type: 'browserServers' });
    assert.deepEqual(last('browserServers')!.servers, [{ url: 'http://localhost:5173/', process: 'vite' }, { url: 'http://localhost:8080/' }]);
  });

  it('finds a port something listens on', async () => {
    const server = http.createServer((_q, r) => r.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      assert.equal(await probePort(port), true);
    } finally {
      server.close();
    }
    await new Promise((r) => server.once('close', r));
    assert.equal(await probePort(port), false);
  });
});
