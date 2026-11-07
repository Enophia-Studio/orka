import { assertReachable, type HeadlessBrowser, stripAnsi, t, type UserKeyEvent, type UserMouseEvent } from '@orka/core';
import * as net from 'node:net';
import type { BrowserInputView, BrowserStateView, DevServerView, SessionMessage, SessionPost } from './protocol';

/** What the panel uses of the session's browser (the agent's: one per session). */
export type PanelBrowser = Pick<
  HeadlessBrowser,
  'running' | 'url' | 'userControl' | 'viewport' | 'onChange' | 'startScreencast' | 'stopScreencast' | 'navigate' | 'userMouse' | 'userKey' | 'history' | 'navigation'
>;

export type BrowserMessage = Extract<SessionMessage, { type: 'browserView' | 'browserOpen' | 'browserNav' | 'browserControl' | 'browserInput' | 'browserServers' }>;
type BrowserPost = Extract<SessionPost, { type: 'browserState' | 'browserFrame' | 'browserServers' }>;

export interface BrowserPanelOptions {
  browser: PanelBrowser;
  /** To the page, as this session's (dropped while the page shows another session). */
  post(message: BrowserPost): void;
  /** The page shows this session. */
  active(): boolean;
  /** The session's background processes (dev servers print their address). */
  processes(): Iterable<{ name: string; output: string; running: boolean }>;
  /** Whether something listens on this local port (tests replace it). */
  probe?(port: number): Promise<boolean>;
}

const MAX_URL = 2048;
/** Ports dev servers commonly use: Next/Express, Vite, Angular, Astro, Django, webpack and others. */
export const DEV_PORTS = [3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];
/** A local address in a process's output (no nested repetition: linear on any text). */
const LOCAL_ADDRESS = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[^\s'"<>`]*)?/g;
const MAX_SERVERS = 12;
const BUTTONS = ['left', 'middle', 'right'] as const;

/**
 * An address the user typed in the Browser panel, as a URL to open, or undefined when it is not
 * one: a bare port ("5173", ":5173") or a host without a scheme ("localhost:3000") gets one
 * (http for this machine, https elsewhere). Only http(s): no file:, javascript:, data: or others.
 */
export function userUrl(text: string): string | undefined {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > MAX_URL || /\s/.test(raw)) return undefined;
  let candidate: string;
  if (/^:?\d{2,5}(\/|$)/.test(raw)) candidate = `http://localhost${raw.startsWith(':') ? '' : ':'}${raw}`;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) candidate = raw;
  else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) return undefined;
  else candidate = `${localHostName(raw) ? 'http' : 'https'}://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined;
  return url.href;
}

function localHostName(raw: string): boolean {
  const host = raw.split(/[/:?#]/, 1)[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost') || raw.startsWith('[::1]');
}

const clamp = (n: unknown, min: number, max: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
const mods = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) ? n & 15 : 0);
const shortText = (s: unknown, max: number) => (typeof s === 'string' && s.length <= max ? s : undefined);

/**
 * The user's input as the browser's own events, in the page's pixels; undefined for anything that
 * is not well-formed (it is dropped).
 */
export function toBrowserInput(input: BrowserInputView, viewport: { width: number; height: number }): { mouse: UserMouseEvent } | { key: UserKeyEvent } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (input.kind === 'mouse' || input.kind === 'wheel') {
    const x = Math.round(clamp(input.x, 0, 1) * (viewport.width - 1));
    const y = Math.round(clamp(input.y, 0, 1) * (viewport.height - 1));
    if (input.kind === 'wheel') {
      return { mouse: { type: 'mouseWheel', x, y, deltaX: clamp(input.dx, -5000, 5000), deltaY: clamp(input.dy, -5000, 5000), modifiers: mods(input.mods) } };
    }
    const type = input.action === 'down' ? 'mousePressed' : input.action === 'up' ? 'mouseReleased' : input.action === 'move' ? 'mouseMoved' : undefined;
    if (!type) return undefined;
    const button = type === 'mouseMoved' ? 'none' : (BUTTONS[clamp(input.button, 0, 2) | 0] ?? 'left');
    return { mouse: { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : Math.round(clamp(input.clicks, 1, 3)), modifiers: mods(input.mods) } };
  }
  if (input.kind === 'key') {
    const key = shortText(input.key, 32);
    const code = shortText(input.code, 32) ?? '';
    if (!key || (input.action !== 'down' && input.action !== 'up')) return undefined;
    // What a key types is one character (or a short composed one), never a pasted text.
    const text = shortText(input.text, 4);
    return {
      key: { type: input.action === 'down' ? 'keyDown' : 'keyUp', key, code, keyCode: Math.round(clamp(input.keyCode, 0, 255)), ...(text ? { text } : {}), modifiers: mods(input.mods) },
    };
  }
  return undefined;
}

/** Local addresses the session's background processes printed, newest last. */
export function printedServers(processes: Iterable<{ name: string; output: string; running: boolean }>): DevServerView[] {
  const found = new Map<string, DevServerView>();
  for (const proc of processes) {
    if (!proc.running) continue;
    const text = stripAnsi(proc.output.slice(-20_000));
    for (const match of text.matchAll(LOCAL_ADDRESS)) {
      let url: URL;
      try {
        url = new URL(trimTrailing(match[0]));
      } catch {
        continue;
      }
      // 0.0.0.0 (all addresses) is reached as localhost.
      if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
      found.set(url.origin, { url: url.href, process: proc.name });
    }
  }
  return [...found.values()];
}

/** A sentence's punctuation after an address is not part of it (a loop: nothing to backtrack on a long run). */
function trimTrailing(text: string): string {
  let end = text.length;
  while (end > 0 && '.,;:)'.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/** Something accepts connections on this port of this machine (IPv4 or IPv6 loopback). */
export function probePort(port: number): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(300, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return one('127.0.0.1').then((ok) => ok || one('::1'));
}

/**
 * The desktop Browser panel of one session: the agent's browser shown live (frames only while the
 * panel shows), the user's own addresses and history buttons, and Take over, which hands the
 * user's mouse and keys to the page while the agent may only look. Frames go to the page in
 * memory; nothing is written to disk.
 */
export class BrowserPanel {
  private visible = false;
  private loading = false;
  private error?: string;
  private stateTimer?: NodeJS.Timeout;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: BrowserPanelOptions) {
    this.unsubscribe = options.browser.onChange(() => this.scheduleState());
  }

  get browser(): PanelBrowser {
    return this.options.browser;
  }

  async handle(message: BrowserMessage): Promise<void> {
    if (this.disposed) return;
    const browser = this.options.browser;
    switch (message.type) {
      case 'browserView':
        if (message.visible === true) await this.show();
        else this.hide(false);
        break;
      case 'browserOpen':
        await this.open(message.url);
        break;
      case 'browserNav':
        if (message.action !== 'back' && message.action !== 'forward' && message.action !== 'reload') return;
        this.error = undefined;
        await browser.history(message.action).catch((e: unknown) => (this.error = errorText(e)));
        this.scheduleState();
        break;
      case 'browserControl':
        // Only a page that is open can be taken over.
        browser.userControl = message.take === true && browser.running;
        this.scheduleState();
        break;
      case 'browserInput': {
        if (!browser.userControl || !browser.running) return;
        const event = toBrowserInput(message.input, browser.viewport);
        if (!event) return;
        // In order (one connection), without waiting: a slow page does not hold the next event back.
        if ('mouse' in event) void browser.userMouse(event.mouse).catch(() => undefined);
        else void browser.userKey(event.key).catch(() => undefined);
        break;
      }
      case 'browserServers':
        this.options.post({ type: 'browserServers', servers: await this.servers() });
        break;
    }
  }

  /** The panel shows: frames start (once the browser runs), and the page gets the state. */
  private async show(): Promise<void> {
    this.visible = true;
    const browser = this.options.browser;
    await browser
      .startScreencast((frame) => {
        if (!this.visible || !this.options.active()) {
          this.hide(false);
          return;
        }
        this.options.post({ type: 'browserFrame', data: frame.data, width: frame.width, height: frame.height });
      })
      .catch(() => undefined);
    await this.postState();
  }

  /**
   * The panel is out of sight: no more frames. release: the page shows another session (or this
   * one goes away), so the user's control ends too and the agent may use the page again.
   */
  hide(release = true): void {
    this.visible = false;
    this.options.browser.stopScreencast();
    if (release) this.options.browser.userControl = false;
  }

  private async open(text: string): Promise<void> {
    const url = userUrl(text);
    if (!url) {
      this.error = t('Only http and https addresses open here.');
      await this.postState();
      return;
    }
    this.error = undefined;
    this.loading = true;
    await this.postState();
    try {
      await assertReachable(new URL(url));
      await this.options.browser.navigate(url);
    } catch (e) {
      this.error = errorText(e);
    } finally {
      this.loading = false;
    }
    await this.postState();
  }

  /** Dev servers to offer: addresses the session's processes printed, then common ports that answer. */
  async servers(): Promise<DevServerView[]> {
    const printed = printedServers(this.options.processes());
    const ports = new Set(printed.map((s) => new URL(s.url).port));
    const probe = this.options.probe ?? probePort;
    const open = await Promise.all(DEV_PORTS.filter((p) => !ports.has(String(p))).map(async (port) => ((await probe(port).catch(() => false)) ? port : undefined)));
    const probed = open.filter((p): p is number => p !== undefined).map((port) => ({ url: `http://localhost:${port}/` }));
    return [...printed, ...probed].slice(0, MAX_SERVERS);
  }

  private scheduleState(): void {
    if (this.disposed || this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      void this.postState();
    }, 30);
    this.stateTimer.unref?.();
  }

  async state(): Promise<BrowserStateView> {
    const browser = this.options.browser;
    const nav = await browser.navigation().catch(() => ({ canBack: false, canForward: false }));
    return {
      running: browser.running,
      url: browser.running ? browser.url : '',
      ...nav,
      control: browser.userControl,
      ...(this.loading ? { loading: true } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private async postState(): Promise<void> {
    if (this.disposed || !this.options.active()) return;
    const state = await this.state();
    if (!this.disposed) this.options.post({ type: 'browserState', state });
  }

  /** The session goes away: no more frames or state, and the page is the agent's again (the host closes the browser). */
  dispose(): void {
    if (this.disposed) return;
    this.hide(true);
    this.disposed = true;
    clearTimeout(this.stateTimer);
    this.unsubscribe();
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
