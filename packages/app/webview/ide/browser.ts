// The desktop app's Browser tab: the session's browser (the one the agent's browser tool uses)
// shown live. The panel is drawn once and then updated in place, so typing in the address bar or
// a focused page keeps its focus while frames arrive. Frames are JPEG data in an <img> (the
// page's CSP allows data: images and nothing remote). Every text is escaped.
import { t } from '@orka/core/src/i18n';
import type { BrowserInputView, BrowserStateView, DevServerView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

export const NO_BROWSER: BrowserStateView = { running: false, url: '', canBack: false, canForward: false, control: false };

/** The panel's fixed parts; browserUpdate fills them in. */
export function browserPanelHtml(): string {
  const nav = (action: string, glyph: string, label: string) =>
    `<button class="icon-btn" data-action="browser-nav" data-nav="${action}" aria-label="${attr(label)}" title="${attr(label)}" disabled>${icon(glyph)}</button>`;
  return `<div class="browser-bar">
      ${nav('back', 'back', t('Back'))}${nav('forward', 'forward', t('Forward'))}${nav('reload', 'refresh', t('Reload'))}
      <input id="browser-url" type="text" spellcheck="false" autocomplete="off" aria-label="${attr(t('Address'))}" placeholder="${attr(t('localhost:5173 or an address'))}">
      <button class="btn small" data-action="browser-go">${escapeHtml(t('Open'))}</button>
    </div>
    <div class="browser-tools">
      <button class="btn small" data-action="browser-control" aria-pressed="false" disabled></button>
      <button class="btn small" data-action="browser-servers">${icon('search')}<span>${escapeHtml(t('Find dev servers'))}</span></button>
    </div>
    <div class="browser-servers" id="browser-servers" hidden></div>
    <div class="browser-error" id="browser-error" role="alert" hidden></div>
    <div class="browser-screen" id="browser-screen" tabindex="-1" aria-label="${attr(t('The page'))}">
      <img id="browser-frame" alt="" draggable="false" hidden>
      <div class="browser-empty muted" id="browser-empty"></div>
    </div>
    <p class="browser-note muted" id="browser-note"></p>`;
}

/** Puts a state into a drawn panel. editing: the user is typing in the address bar (it keeps what they typed). */
export function browserUpdate(panel: HTMLElement, state: BrowserStateView, editing: boolean): void {
  const q = <T extends HTMLElement>(s: string) => panel.querySelector<T>(s);
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-action="browser-nav"]')) {
    const action = button.dataset.nav;
    button.disabled = !state.running || (action === 'back' ? !state.canBack : action === 'forward' ? !state.canForward : false);
  }
  const url = q<HTMLInputElement>('#browser-url');
  if (url && !editing) url.value = state.running && state.url !== 'about:blank' ? state.url : url.value;
  const go = q<HTMLButtonElement>('[data-action="browser-go"]');
  if (go) {
    go.disabled = !!state.loading;
    go.textContent = state.loading ? t('Opening…') : t('Open');
  }
  const control = q<HTMLButtonElement>('[data-action="browser-control"]');
  if (control) {
    control.disabled = !state.running;
    control.setAttribute('aria-pressed', String(state.control));
    control.classList.toggle('primary', state.control);
    control.innerHTML = `${icon(state.control ? 'undo' : 'user')}<span>${escapeHtml(state.control ? t('Give back') : t('Take over'))}</span>`;
  }
  const error = q('#browser-error');
  if (error) {
    error.hidden = !state.error;
    error.textContent = state.error ?? '';
  }
  const screen = q('#browser-screen');
  if (screen) {
    screen.classList.toggle('control', state.control);
    screen.tabIndex = state.control ? 0 : -1;
    screen.setAttribute('aria-label', state.control ? t('The page: your mouse and keys go to it. Shift+Escape gives control back.') : t('The page'));
  }
  const frame = q<HTMLImageElement>('#browser-frame');
  if (frame && !state.running) {
    frame.hidden = true;
    frame.removeAttribute('src');
  }
  const empty = q('#browser-empty');
  if (empty) {
    empty.hidden = state.running && !!frame && !frame.hidden;
    empty.textContent = state.running ? t('Waiting for the page…') : t("No page is open. Type a localhost address or pick a dev server; pages the agent opens with its browser show here too.");
  }
  const note = q('#browser-note');
  if (note) {
    note.textContent = state.control
      ? t('You have the page: the agent can only look at it until you give it back.')
      : t('The agent and you share this browser. It closes with the session; nothing is recorded.');
  }
}

/** A frame of the page; only base64 JPEG data is shown. */
export function browserFrame(panel: HTMLElement, data: unknown): void {
  const frame = panel.querySelector<HTMLImageElement>('#browser-frame');
  if (!frame || typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  frame.src = `data:image/jpeg;base64,${data}`;
  if (frame.hidden) {
    frame.hidden = false;
    const empty = panel.querySelector<HTMLElement>('#browser-empty');
    if (empty) empty.hidden = true;
  }
}

/** The dev servers found: one button each; none found says so. */
export function browserServersHtml(servers: DevServerView[]): string {
  if (!servers.length) return `<span class="muted">${escapeHtml(t('No dev server found on this machine. Start one, or type its address.'))}</span>`;
  return servers
    .map((s) => {
      const label = s.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const title = s.process ? t('Printed by {name}', { name: s.process }) : s.url;
      return `<button class="chip" data-action="browser-open-server" data-url="${attr(s.url)}" title="${attr(title)}">${icon('globe')}<span>${escapeHtml(label)}</span></button>`;
    })
    .join('');
}

/** Alt 1, Ctrl 2, Meta 4, Shift 8, as the app expects them. */
export function modifiers(e: MouseEvent | KeyboardEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/**
 * Where on the shown frame an event is, from 0 to 1 of its width and height: undefined outside it,
 * or (toEdge) the nearest point on its edge.
 */
export function framePoint(frame: HTMLImageElement, e: MouseEvent, toEdge = false): { x: number; y: number } | undefined {
  const box = frame.getBoundingClientRect();
  if (!box.width || !box.height) return undefined;
  const x = (e.clientX - box.left) / box.width;
  const y = (e.clientY - box.top) / box.height;
  if (toEdge) return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  if (x < 0 || y < 0 || x > 1 || y > 1) return undefined;
  return { x, y };
}

/** A key event for the page: printable keys carry their character (Enter types a return). */
export function keyInput(e: KeyboardEvent, action: 'down' | 'up'): BrowserInputView {
  const text = action === 'down' && !e.ctrlKey && !e.metaKey ? (e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined) : undefined;
  return { kind: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode || 0, ...(text ? { text } : {}), mods: modifiers(e) };
}
