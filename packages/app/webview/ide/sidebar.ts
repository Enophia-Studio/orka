// The desktop app's session list: the tasks of the recent project folders, newest first, with the
// sessions open now (one per folder) marked: running, waiting for an approval, or shown.
import type { TaskSummary } from '@orka/core';
import { t, tn } from '@orka/core/src/i18n';
import type { LiveSessionView, RadarView, SessionGroup, SessionOrganizerView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';
import { ago } from '../core/format';
import { radarBadge, radarLabel } from '../features/radar';

export interface SidebarView {
  /** The recent folders with their newest tasks. */
  groups: SessionGroup[];
  /** The user's own groups and hidden sessions. */
  organizer: SessionOrganizerView;
  /** Folded sections: "group:<id>" or "folder:<path>". */
  collapsed: ReadonlySet<string>;
  showHidden: boolean;
  /** The open sessions, and the one the page shows. */
  live: LiveSessionView[];
  activeId?: string;
  /** Title of the shown session's task while it is not in the history yet (empty: a new task). */
  draftTitle: string;
  query: string;
}

/**
 * Head, search box and footer; the list and the theme switch are filled in separately. When the
 * sidebar is closed, only the rail of icons at the end shows.
 */
export function sidebarFrame(logo: string): string {
  const railButton = (action: string, glyph: string, label: string, keys?: string) =>
    `<button class="icon-btn" data-action="${action}" aria-label="${attr(label)}" title="${attr(keys ? `${label} (${keys})` : label)}">${icon(glyph)}</button>`;
  return `
    <div class="side-head">
      <img class="side-logo" src="${attr(logo)}" width="22" height="22" alt=""><strong>Orka</strong><span class="spacer"></span>
      <span class="side-approvals" id="side-approvals"></span>
      ${railButton('toggle-sidebar', 'sidebar', t('Hide the sidebar'), 'Ctrl+B')}
    </div>
    <button class="side-new" data-action="new-session" title="${attr(`${t('New session')} (Ctrl+Alt+N)`)}"><span class="side-new-icon">${icon('plus')}</span><span>${escapeHtml(t('New session'))}</span></button>
    <div class="side-search-row">
      <label class="side-search">${icon('search')}<input id="side-search" type="search" placeholder="${attr(t('Search sessions'))}" aria-label="${attr(t('Search sessions'))}" spellcheck="false"></label>
      ${railButton('new-group', 'folderPlus', t('New group'))}
    </div>
    <nav class="side-list" id="side-list" aria-label="${attr(t('Sessions'))}"></nav>
    <div class="side-foot">
      <div class="side-files" id="side-files"></div>
      <div class="side-radar" id="side-radar"></div>
      <button class="side-link" data-action="open-folder">${icon('folder')}<span>${escapeHtml(t('Open folder…'))}</span></button>
      <div class="side-foot-row">
        <button class="side-link" data-action="open-settings">${icon('gear')}<span>${escapeHtml(t('Settings'))}</span></button>
        <span class="spacer"></span>
        <div class="theme-switch" id="theme-switch" role="group" aria-label="${attr(t('Theme'))}"></div>
      </div>
    </div>
    <div class="side-rail">
      ${railButton('toggle-sidebar', 'sidebar', t('Show the sidebar'), 'Ctrl+B')}
      <span class="rail-new">${railButton('new-session', 'plus', t('New session'), 'Ctrl+Alt+N')}</span>
      ${railButton('search-sessions', 'search', t('Search sessions'), 'Ctrl+K')}
      <span class="rail-approvals" id="rail-approvals"></span>
      <span class="spacer"></span>
      <span class="rail-files" id="rail-files"></span>
      <span class="rail-radar" id="rail-radar"></span>
      ${railButton('open-folder', 'folder', t('Open folder…'))}
      ${railButton('open-settings', 'gear', t('Settings'))}
    </div>`;
}

/** Radar in the session list's footer and in the rail, with the count of new entries (desktop, once Radar reported in). */
export function radarEntryHtml(where: 'list' | 'rail', radar: RadarView | undefined): string {
  // The badge is only seen; the button's name says the count.
  const label = radarLabel(t('Radar: what other AI coding tools shipped'), radar);
  const badge = radarBadge(radar);
  return where === 'rail'
    ? `<button class="icon-btn" data-action="open-radar" aria-label="${attr(label)}" title="${attr(label)}">${icon('radar')}${badge}</button>`
    : `<button class="side-link" data-action="open-radar" aria-label="${attr(label)}" title="${attr(label)}">${icon('radar')}<span>Radar</span>${badge}</button>`;
}

/** The open sessions, other than the one shown, that wait for an approval. */
export function waitingSessions(live: readonly LiveSessionView[], activeId: string | undefined): LiveSessionView[] {
  return live.filter((s) => s.id !== activeId && s.state === 'approval');
}

/**
 * The count of other sessions waiting for an approval, in the sidebar's head and in the rail; a
 * click shows the first of them. Empty while none waits.
 */
export function approvalsBadgeHtml(where: 'head' | 'rail', live: readonly LiveSessionView[], activeId: string | undefined): string {
  const waiting = waitingSessions(live, activeId);
  if (!waiting.length) return '';
  const label = tn('{n} session needs approval', '{n} sessions need approval', waiting.length);
  const count = waiting.length > 99 ? '99+' : String(waiting.length);
  return `<button class="${where === 'rail' ? 'icon-btn' : 'approvals-badge'}" data-action="switch-session" data-session="${attr(waiting[0].id)}" aria-label="${attr(label)}" title="${attr(label)}">${icon('shield')}<span class="approvals-count" aria-hidden="true">${count}</span></button>`;
}

export function themeSwitchHtml(theme: 'system' | 'light' | 'dark'): string {
  const options: Array<[typeof theme, string, string]> = [
    ['system', 'monitor', t('Follow the system')],
    ['light', 'sun', t('Light')],
    ['dark', 'moon', t('Dark')],
  ];
  return options
    .map(
      ([value, glyph, label]) =>
        `<button class="${value === theme ? 'on' : ''}" data-action="set-setting" data-key="desktop.theme" data-value="${value}" aria-pressed="${value === theme}" aria-label="${attr(label)}" title="${attr(label)}">${icon(glyph)}</button>`,
    )
    .join('');
}

interface Listed {
  task: TaskSummary;
  folder: string;
  folderName: string;
}

/** A row's classes and the mark before its title for the open session it shows, if any. */
function liveState(live: LiveSessionView | undefined): { cls: string; mark: string } {
  if (live?.state === 'approval') {
    return { cls: ' needs-approval', mark: `<span class="approval-mark" role="img" aria-label="${attr(t('Needs approval'))}" title="${attr(t('Needs approval'))}">${icon('shield')}</span>` };
  }
  if (live?.state === 'running') return { cls: ' running', mark: '<span class="run-dot"></span>' };
  return { cls: '', mark: '' };
}

/** The … button of a row; an open session that is not shown also names itself (Close or Stop in its menu). */
function moreButton(taskId: string, folder: string, live: LiveSessionView | undefined, shown: boolean, draft = false): string {
  const session = live && !shown ? ` data-session="${attr(live.id)}" data-state="${attr(live.state)}"${draft ? ' data-draft="true"' : ''}` : '';
  return `<button class="icon-btn side-more" data-action="session-menu" data-id="${attr(taskId)}" data-folder="${attr(folder)}"${session} aria-haspopup="menu" aria-label="${attr(
    t('More for this session'),
  )}" title="${attr(t('More for this session'))}">${icon('more')}</button>`;
}

/**
 * The list: the user's own groups first, then each recent folder with its other sessions, then (on
 * request) the hidden ones. Sections fold away; a search shows every match, folded or not. A row of
 * an open session that is not shown switches to it; nothing of either session stops.
 */
export function sessionListHtml(v: SidebarView): string {
  const query = v.query.trim().toLowerCase();
  const matches = (title: string) => !query || title.toLowerCase().includes(query);
  const hidden = new Set(v.organizer.hidden);
  const all: Listed[] = v.groups.flatMap((g) => g.tasks.map((task) => ({ task, folder: g.folder, folderName: g.name })));
  const liveOf = (folder: string, taskId: string) => v.live.find((s) => s.taskId === taskId && samePath(s.folder, folder));
  const shownFolder = v.live.find((s) => s.id === v.activeId)?.folder;
  const row = (item: Listed, meta?: string) => {
    const live = liveOf(item.folder, item.task.id);
    const shown = !!live && live.id === v.activeId;
    const state = liveState(live);
    const action = live && !shown ? `data-action="switch-session" data-session="${attr(live.id)}"` : 'data-action="open-session"';
    return `<div class="side-item${shown ? ' current' : ''}${state.cls}">
      <button class="side-open" ${action} data-id="${attr(item.task.id)}" data-folder="${attr(item.folder)}" title="${attr(`${item.task.title}\n${item.folderName} · ${ago(item.task.updatedAt)}`)}"${shown ? ' aria-current="true"' : ''}>
        <span class="side-title">${state.mark}<span class="ellipsis">${escapeHtml(item.task.title)}</span>${meta ? `<span class="side-meta">${escapeHtml(meta)}</span>` : ''}</span></button>
      ${moreButton(item.task.id, item.folder, live, shown)}
    </div>`;
  };
  /** An open session whose task is not in the history yet (a new task, or one not saved so far). */
  const draftRow = (live: LiveSessionView, folder: string) => {
    const shown = live.id === v.activeId;
    const title = (shown ? v.draftTitle || live.title : live.title) || t('New session');
    const state = liveState(live);
    const inner = `<span class="side-title">${state.mark}<span class="ellipsis">${escapeHtml(title)}</span></span>`;
    return shown
      ? `<div class="side-item current draft${state.cls}"><span class="side-open" aria-current="true">${inner}</span></div>`
      : `<div class="side-item draft${state.cls}"><button class="side-open" data-action="switch-session" data-session="${attr(live.id)}" title="${attr(title)}">${inner}</button>
      ${moreButton(live.taskId, folder, live, false, true)}</div>`;
  };
  /** A foldable section; `buttons` sit at the end of its heading. */
  const section = (key: string, head: string, rows: string[], cls: string, buttons: string) => {
    const folded = v.collapsed.has(key) && !query;
    return `<div class="side-group${cls}${folded ? ' folded' : ''}">
      <div class="side-group-head"><button class="side-fold" data-action="toggle-section" data-key="${attr(key)}" aria-expanded="${!folded}">${icon('chevron', 'fold-chevron')}${head}</button>${buttons}</div>
      ${folded ? '' : rows.join('')}</div>`;
  };

  const out: string[] = [];
  for (const group of v.organizer.groups) {
    const items = all.filter((i) => v.organizer.assigned[i.task.id] === group.id && !hidden.has(i.task.id) && matches(i.task.title));
    if (query && !items.length) continue;
    const head = `<span class="ellipsis">${escapeHtml(group.name)}</span><span class="side-count">${items.length}</span>`;
    const actions = `<span class="side-group-actions">
        <button class="icon-btn" data-action="group-rename" data-group="${attr(group.id)}" aria-label="${attr(t('Rename group'))}" title="${attr(t('Rename group'))}">${icon('edit')}</button>
        <button class="icon-btn" data-action="group-delete" data-group="${attr(group.id)}" aria-label="${attr(t('Remove the group (its sessions stay)'))}" title="${attr(t('Remove the group (its sessions stay)'))}">${icon('x')}</button></span>`;
    const rows = items.length ? items.map((i) => row(i, i.folderName)) : [`<div class="side-empty">${escapeHtml(t('Move sessions here with their … menu.'))}</div>`];
    out.push(section(`group:${group.id}`, head, rows, ' user-group', actions));
  }

  for (const folder of v.groups) {
    const current = !!shownFolder && samePath(folder.folder, shownFolder);
    const items = all.filter((i) => i.folder === folder.folder && !v.organizer.assigned[i.task.id] && !hidden.has(i.task.id) && matches(i.task.title));
    // An open session's task is listed once it is saved; until then it shows as a draft at the top.
    const drafts = v.live.filter(
      (s) =>
        samePath(s.folder, folder.folder) &&
        !folder.tasks.some((task) => task.id === s.taskId) &&
        matches((s.id === v.activeId ? v.draftTitle || s.title : s.title) || t('New session')),
    );
    if (query && !items.length && !drafts.length) continue;
    const rows = [...drafts.map((s) => draftRow(s, folder.folder)), ...items.map((i) => row(i))];
    if (!rows.length) rows.push(`<div class="side-empty">${escapeHtml(t('No sessions yet.'))}</div>`);
    const head = `${icon('folder')}<span class="ellipsis" title="${attr(folder.folder)}">${escapeHtml(folder.name)}</span>`;
    const add = `<button class="icon-btn" data-action="new-session" data-folder="${attr(folder.folder)}" aria-label="${attr(t('New session in {folder}', { folder: folder.name }))}" title="${attr(t('New session in {folder}', { folder: folder.name }))}">${icon('plus')}</button>`;
    out.push(section(`folder:${folder.folder}`, head, rows, current ? ' current' : '', add));
  }

  const hiddenItems = all.filter((i) => hidden.has(i.task.id) && matches(i.task.title));
  if (hiddenItems.length) {
    out.push(`<button class="side-hidden-toggle" data-action="toggle-hidden" aria-expanded="${v.showHidden}">${icon(v.showHidden ? 'eye' : 'ban')}<span>${escapeHtml(
      v.showHidden ? t('Hide the hidden sessions') : tn('{n} hidden session', '{n} hidden sessions', hiddenItems.length),
    )}</span></button>`);
    if (v.showHidden) out.push(`<div class="side-group hidden-group">${hiddenItems.map((i) => row(i, i.folderName)).join('')}</div>`);
  }

  if (out.length) return out.join('');
  return `<div class="side-empty">${escapeHtml(query ? t('No session matches.') : t('Open a folder to start a session.'))}</div>`;
}

/** An open session that is not shown, as its … menu offers it: Stop while it runs, else Close. */
export interface MenuSession {
  id: string;
  running: boolean;
  /** Its task is not saved yet: the menu offers nothing else. */
  draft: boolean;
}

/**
 * The … menu of a session: stop or close it while it is open in the background, move it to a
 * group, out of it, hide or show it, delete it.
 */
export function sessionMenuHtml(taskId: string, folder: string, organizer: SessionOrganizerView, live?: MenuSession): string {
  const inGroup = organizer.assigned[taskId];
  const hidden = organizer.hidden.includes(taskId);
  const item = (action: string, glyph: string, label: string, extra = '', cls = '') =>
    `<button class="menu-item${cls}" role="menuitem" data-action="${action}" data-id="${attr(taskId)}" data-folder="${attr(folder)}"${extra}>${icon(glyph)}<span>${escapeHtml(label)}</span></button>`;
  const liveItem = live
    ? live.running
      ? item('stop-session', 'stop', t('Stop'), ` data-session="${attr(live.id)}"`)
      : item('close-session', 'x', t('Close (keeps it in the list)'), ` data-session="${attr(live.id)}"`)
    : '';
  if (live?.draft) return liveItem;
  const groups = organizer.groups
    .filter((g) => g.id !== inGroup)
    .map((g) => item('session-to-group', 'folder', g.name, ` data-group="${attr(g.id)}"`))
    .join('');
  return `${liveItem ? `${liveItem}<hr>` : ''}${organizer.groups.length > (inGroup ? 1 : 0) ? `<div class="menu-label">${escapeHtml(t('Move to group'))}</div>${groups}` : ''}
    ${item('session-new-group', 'plus', t('New group…'))}
    ${inGroup ? item('session-ungroup', 'undo', t('Take out of the group')) : ''}
    <hr>
    ${item('session-hide', hidden ? 'eye' : 'ban', hidden ? t('Show in the list') : t('Hide from the list'), ` data-hidden="${!hidden}"`)}
    ${item('delete-session', 'delete', t('Delete'), '', ' danger')}`;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
