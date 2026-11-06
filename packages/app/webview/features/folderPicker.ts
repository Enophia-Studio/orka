// The desktop app's own folder picker ("Open folder…"): the subfolders of a folder (never a file),
// the places to start from, a new folder, and the system's dialog as a fallback.
import { t, tn } from '@orka/core/src/i18n';
import type { CreateFolderError, FolderListingError, FolderPlaceView, ToWebview } from '../../src/protocol';
import { post } from '../core/bridge';
import { attr, escapeHtml, icon } from '../core/dom';
import { addModal, questionOpen } from './dialogs';

type Listing = Extract<ToWebview, { type: 'folderListing' }>;
type Created = Extract<ToWebview, { type: 'folderCreated' }>;

interface Picker {
  /** A folder to work in, or none: the system's folder dialog instead. */
  choose: (path?: string) => void;
  opener: HTMLElement | null;
  root: HTMLElement;
  /** The folder shown (with an error when it could not be read). */
  listing?: Listing;
  places: FolderPlaceView[];
  hidden: boolean;
  /** Index of the selected subfolder in listing.entries. */
  selected?: number;
  pathError?: string;
  /** The New folder row is open. */
  creating?: { error?: string; busy: boolean };
  /** The newest listFolders and createFolder ids: older answers are dropped. */
  request: number;
  createRequest: number;
  /** The folder shown when the newest request was sent, kept for Go back once the answer comes. */
  from?: string;
  /** Select this subfolder in the next listing (a folder just created). */
  selectName?: string;
  /** Folders shown before, for Go back. */
  back: string[];
  loading: boolean;
}

let picker: Picker | undefined;
let nextId = 0;
const layer = document.createElement('div');
layer.className = 'folder-picker-layer';
document.body.appendChild(layer);
addModal(() => !!picker);

/** Open the picker; `choose` gets the folder picked, or no path for the system's dialog. Nothing when it is open already. */
export function openFolderPicker(choose: (path?: string) => void, opener: Element | null): void {
  if (picker) return;
  layer.innerHTML = shellHtml();
  picker = {
    choose,
    opener: opener instanceof HTMLElement ? opener : null,
    root: layer.querySelector<HTMLElement>('.folder-picker')!,
    places: [],
    hidden: false,
    request: 0,
    createRequest: 0,
    back: [],
    loading: true,
  };
  list(undefined, { places: true, remember: false });
  render();
  field('.fp-filter')?.focus();
}

export function folderPickerOpen(): boolean {
  return !!picker;
}

/** The app's answer to listFolders. */
export function folderPickerListing(message: Listing): void {
  const p = picker;
  if (!p || message.id !== p.request) return;
  p.loading = false;
  if (message.places) p.places = message.places;
  // A path typed in that leads nowhere keeps the folder shown and says why under the field.
  if (p.listing && !p.listing.error && (message.error === 'invalid' || message.error === 'notFound')) {
    p.pathError = message.error === 'invalid' ? t('Enter a full path, from the root of a drive.') : t('There is no folder at this path.');
    p.from = undefined;
    render();
    field('.fp-path')?.focus();
    return;
  }
  if (p.from && p.from !== message.path) p.back.push(p.from);
  p.from = undefined;
  p.listing = message;
  p.pathError = undefined;
  const name = p.selectName;
  p.selectName = undefined;
  const index = name === undefined ? -1 : message.entries.findIndex((e) => e.name === name);
  p.selected = index >= 0 ? index : undefined;
  const filter = field('.fp-filter');
  if (filter) filter.value = '';
  const path = field('.fp-path');
  if (path) path.value = message.path;
  render();
  if (p.selected !== undefined) scrollToSelected();
}

/** The app's answer to createFolder: the new folder is selected in the folder shown. */
export function folderPickerCreated(message: Created): void {
  const p = picker;
  if (!p || message.id !== p.createRequest || !p.creating) return;
  if (message.error || !message.name) {
    p.creating = { busy: false, error: createError(message.error ?? 'failed') };
    render();
    field('.fp-new-name')?.focus();
    return;
  }
  p.creating = undefined;
  p.selectName = message.name;
  if (p.listing?.path) list(p.listing.path, { remember: false });
  render();
  p.root.querySelector<HTMLElement>('.fp-list')?.focus();
}

// ---------------------------------------------------------------- requests and actions

function list(path: string | undefined, options: { places?: boolean; remember?: boolean } = {}): void {
  const p = picker!;
  p.request = ++nextId;
  p.loading = true;
  p.from = options.remember === false ? undefined : p.listing?.path || undefined;
  post({ type: 'listFolders', id: p.request, ...(path !== undefined ? { path } : {}), hidden: p.hidden, ...(options.places ? { places: true } : {}) });
}

function goTo(path: string): void {
  if (!picker) return;
  picker.pathError = undefined;
  list(path);
  render();
}

function goUp(): void {
  const parent = picker?.listing?.parent;
  if (parent) goTo(parent);
}

function goBack(): void {
  const p = picker;
  if (!p) return;
  const previous = p.back.pop() ?? p.listing?.parent;
  if (previous) {
    list(previous, { remember: false });
    render();
  }
}

/** The subfolder that Open (or Enter) would go into. */
function selectedEntry(): Listing['entries'][number] | undefined {
  const p = picker;
  return p?.selected === undefined ? undefined : p.listing?.entries[p.selected];
}

/** What Open opens: the selected subfolder, else the folder shown (none while it could not be read). */
function openTarget(): string | undefined {
  const p = picker;
  if (!p?.listing || p.listing.error || p.loading) return undefined;
  return selectedEntry()?.path ?? (p.listing.path || undefined);
}

function close(choice?: { path?: string }): void {
  const p = picker;
  if (!p) return;
  picker = undefined;
  layer.innerHTML = '';
  if (p.opener?.isConnected) p.opener.focus();
  if (choice) p.choose(choice.path);
}

function select(index: number | undefined, focusList = true): void {
  const p = picker;
  if (!p) return;
  p.selected = index;
  renderSelection();
  renderFooter();
  if (focusList) p.root.querySelector<HTMLElement>('.fp-list')?.focus();
  scrollToSelected();
}

/** Visible items (the filter hides the others), in order. */
function visibleIndexes(): number[] {
  const p = picker;
  if (!p) return [];
  return [...p.root.querySelectorAll<HTMLElement>('.fp-item:not([hidden])')].map((item) => Number(item.dataset.index));
}

function moveSelection(key: string): void {
  const visible = visibleIndexes();
  if (!visible.length) return;
  const at = picker?.selected === undefined ? -1 : visible.indexOf(picker.selected);
  const page = 10;
  const next =
    key === 'Home' ? 0
    : key === 'End' ? visible.length - 1
    : key === 'ArrowUp' ? Math.max(0, at < 0 ? 0 : at - 1)
    : key === 'PageUp' ? Math.max(0, at - page)
    : key === 'PageDown' ? Math.min(visible.length - 1, at < 0 ? page - 1 : at + page)
    : Math.min(visible.length - 1, at + 1);
  select(visible[next]);
}

function openSelected(): void {
  const entry = selectedEntry();
  if (entry) goTo(entry.path);
}

function startCreating(): void {
  const p = picker;
  if (!p?.listing || p.listing.error) return;
  p.creating = { busy: false };
  render();
  const input = field('.fp-new-name');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function submitCreate(): void {
  const p = picker;
  const parent = p?.listing?.path;
  if (!p?.creating || p.creating.busy || !parent) return;
  const name = field('.fp-new-name')?.value ?? '';
  if (!name.trim()) {
    p.creating = { busy: false, error: createError('empty') };
    render();
    return;
  }
  p.createRequest = ++nextId;
  p.creating = { busy: true };
  post({ type: 'createFolder', id: p.createRequest, parent, name });
  render();
}

function cancelCreating(): void {
  if (!picker?.creating) return;
  picker.creating = undefined;
  render();
  picker.root.querySelector<HTMLElement>('[data-fp="new"]')?.focus();
}

function createError(error: CreateFolderError): string {
  switch (error) {
    case 'empty':
      return t('Enter a name.');
    case 'tooLong':
      return t('The name is too long.');
    case 'separator':
      return t('A folder name cannot contain / or \\.');
    case 'reserved':
      return t('The system reserves this name.');
    case 'invalidChars':
      return t('A folder name cannot contain < > : " | ? * or control characters.');
    case 'trailing':
      return t('A folder name cannot end with a dot or a space.');
    case 'exists':
      return t('Something with this name already exists here.');
    case 'denied':
      return t('Orka may not create a folder here.');
    case 'notFound':
      return t('This folder no longer exists.');
    default:
      return t('The folder could not be created.');
  }
}

function listingMessage(error: FolderListingError): string {
  return error === 'denied' ? t('Access to this folder was denied.') : error === 'unreadable' ? t('This folder could not be read.') : t('There is no folder at this path.');
}

// ---------------------------------------------------------------- rendering

function field(selector: string): HTMLInputElement | null {
  return picker?.root.querySelector<HTMLInputElement>(selector) ?? null;
}

/** The parts that stay while the picker is open (the fields keep what is typed in them). */
function shellHtml(): string {
  return `<div class="modal-backdrop fp-backdrop">
    <div class="dialog modal folder-picker" role="dialog" aria-modal="true" aria-labelledby="fp-title">
      <div class="fp-head"><strong class="dialog-title" id="fp-title">${escapeHtml(t('Open folder'))}</strong>
        <button class="icon-btn" type="button" data-fp="cancel" aria-label="${attr(t('Close'))}" title="${attr(t('Close'))}">${icon('x')}</button></div>
      <div class="fp-body">
        <nav class="fp-places" aria-label="${attr(t('Places'))}"></nav>
        <div class="fp-main">
          <div class="fp-location">
            <button class="icon-btn" type="button" data-fp="up" aria-label="${attr(t('Up one folder'))}" title="${attr(t('Up one folder'))} (Alt+↑)">${icon('arrowUp')}</button>
            <nav class="fp-crumbs" aria-label="${attr(t('Path'))}"></nav>
          </div>
          <input class="dialog-input fp-path" type="text" autocomplete="off" spellcheck="false" aria-label="${attr(t('Folder path'))}" aria-describedby="fp-path-error">
          <span class="dialog-error fp-path-error" id="fp-path-error" role="alert" hidden></span>
          <div class="fp-tools">
            <input class="dialog-filter fp-filter" type="text" autocomplete="off" spellcheck="false" placeholder="${attr(t('Filter folders…'))}" aria-label="${attr(t('Filter folders…'))}">
            <label class="fp-hidden"><input type="checkbox" class="fp-hidden-box">${escapeHtml(t('Show hidden folders'))}</label>
          </div>
          <form class="fp-new" data-fp-new hidden>
            ${icon('folderPlus')}
            <input class="dialog-input fp-new-name" type="text" autocomplete="off" spellcheck="false" placeholder="${attr(t('Folder name'))}" aria-label="${attr(t('Folder name'))}" aria-describedby="fp-new-error">
            <button class="btn small primary" type="submit">${escapeHtml(t('Create'))}</button>
            <button class="btn small" type="button" data-fp="new-cancel">${escapeHtml(t('Cancel'))}</button>
            <span class="dialog-error fp-new-error" id="fp-new-error" role="alert" hidden></span>
          </form>
          <div class="fp-list" role="listbox" tabindex="0" aria-label="${attr(t('Folders'))}"></div>
          <div class="fp-note muted small" aria-live="polite"></div>
        </div>
      </div>
      <div class="dialog-actions fp-actions">
        <button class="btn" type="button" data-fp="new">${icon('folderPlus')}${escapeHtml(t('New folder'))}</button>
        <button class="link" type="button" data-fp="system">${escapeHtml(t('Use system dialog…'))}</button>
        <span class="fp-target muted small"></span>
        <button class="btn" type="button" data-fp="cancel">${escapeHtml(t('Cancel'))}</button>
        <button class="btn primary" type="button" data-fp="open">${escapeHtml(t('Open'))}</button>
      </div>
    </div>
  </div>`;
}

function render(): void {
  renderPlaces();
  renderLocation();
  renderList();
  renderFooter();
}

const PLACE_ICON: Record<FolderPlaceView['kind'], string> = {
  recent: 'history',
  home: 'user',
  desktop: 'monitor',
  documents: 'files',
  downloads: 'arrowDown',
  drive: 'drive',
  root: 'drive',
  volume: 'drive',
};

function placeLabel(place: FolderPlaceView): string {
  switch (place.kind) {
    case 'home':
      return t('Home');
    case 'desktop':
      return t('Desktop');
    case 'documents':
      return t('Documents');
    case 'downloads':
      return t('Downloads');
    default:
      return place.name;
  }
}

function renderPlaces(): void {
  const p = picker!;
  const nav = p.root.querySelector<HTMLElement>('.fp-places')!;
  const groups: Array<[string, Array<FolderPlaceView['kind']>]> = [
    [t('Recent'), ['recent']],
    [t('Places'), ['home', 'desktop', 'documents', 'downloads']],
    [t('Drives'), ['drive']],
    [t('Volumes'), ['root', 'volume']],
  ];
  const shown = p.listing?.path ?? '';
  nav.innerHTML = groups
    .map(([label, kinds]) => {
      const items = p.places.map((place, i) => [place, i] as const).filter(([place]) => kinds.includes(place.kind));
      if (!items.length) return '';
      return `<div class="fp-group"><span class="fp-group-label">${escapeHtml(label)}</span>${items
        .map(([place, i]) => {
          const current = samePath(place.path, shown);
          return `<button class="fp-place${current ? ' current' : ''}" type="button" data-fp="place" data-index="${i}" title="${attr(place.path)}"${current ? ' aria-current="location"' : ''}>${icon(PLACE_ICON[place.kind] ?? 'folder')}<span>${escapeHtml(placeLabel(place))}</span></button>`;
        })
        .join('')}</div>`;
    })
    .join('');
}

function renderLocation(): void {
  const p = picker!;
  const listing = p.listing;
  const crumbs = p.root.querySelector<HTMLElement>('.fp-crumbs')!;
  const segments = listing?.segments ?? [];
  crumbs.innerHTML = segments
    .map((segment, i) => {
      const last = i === segments.length - 1;
      return `${i ? icon('chevron', 'fp-sep') : ''}<button class="fp-crumb" type="button" data-fp="crumb" data-index="${i}" title="${attr(segment.path)}"${last ? ' aria-current="location"' : ''}>${escapeHtml(segment.name)}</button>`;
    })
    .join('');
  crumbs.scrollLeft = crumbs.scrollWidth;
  p.root.querySelector<HTMLButtonElement>('[data-fp="up"]')!.disabled = !listing?.parent;
  const error = p.root.querySelector<HTMLElement>('.fp-path-error')!;
  error.hidden = !p.pathError;
  error.textContent = p.pathError ?? '';
  field('.fp-path')?.setAttribute('aria-invalid', p.pathError ? 'true' : 'false');
}

function renderList(): void {
  const p = picker!;
  const listing = p.listing;
  const box = p.root.querySelector<HTMLElement>('.fp-list')!;
  const note = p.root.querySelector<HTMLElement>('.fp-note')!;
  box.setAttribute('aria-busy', p.loading ? 'true' : 'false');
  if (!listing) {
    box.innerHTML = `<div class="fp-empty muted">${escapeHtml(t('Loading…'))}</div>`;
    note.textContent = '';
    return;
  }
  if (listing.error) {
    box.innerHTML = `<div class="fp-message" role="status">${icon('warn')}<span>${escapeHtml(listingMessage(listing.error))}</span>${
      p.back.length || listing.parent ? `<button class="btn small" type="button" data-fp="back">${icon('back')}${escapeHtml(t('Go back'))}</button>` : ''
    }</div>`;
    note.textContent = '';
    box.removeAttribute('aria-activedescendant');
    return;
  }
  box.innerHTML = listing.entries.length
    ? listing.entries
        .map(
          (entry, i) =>
            `<div class="fp-item" role="option" id="fp-opt-${i}" aria-selected="false" data-index="${i}" data-filter="${attr(entry.name.toLowerCase())}" title="${attr(entry.path)}">${icon('folder')}<span class="fp-name">${escapeHtml(entry.name)}</span>${
              entry.link ? `<span class="fp-link" title="${attr(t('A link to another folder'))}">${escapeHtml(t('link'))}</span>` : ''
            }</div>`,
        )
        .join('')
    : `<div class="fp-empty muted">${escapeHtml(t('No subfolders here.'))}</div>`;
  applyFilter();
  renderSelection();
}

/** The filter hides the folders whose name does not contain what is typed. */
function applyFilter(): void {
  const p = picker;
  if (!p?.listing || p.listing.error) return;
  const query = (field('.fp-filter')?.value ?? '').trim().toLowerCase();
  let shown = 0;
  for (const item of p.root.querySelectorAll<HTMLElement>('.fp-item')) {
    item.hidden = !!query && !(item.dataset.filter ?? '').includes(query);
    if (!item.hidden) shown++;
  }
  if (p.selected !== undefined && p.root.querySelector<HTMLElement>(`#fp-opt-${p.selected}`)?.hidden) p.selected = undefined;
  const note = p.root.querySelector<HTMLElement>('.fp-note')!;
  const total = p.listing.entries.length;
  note.textContent =
    query && total && !shown
      ? t('No folders match.')
      : p.listing.truncated
        ? t('First {n} folders shown.', { n: total })
        : total
          ? tn('{n} folder', '{n} folders', query ? shown : total)
          : '';
}

function renderSelection(): void {
  const p = picker!;
  const box = p.root.querySelector<HTMLElement>('.fp-list')!;
  for (const item of box.querySelectorAll<HTMLElement>('.fp-item')) {
    const on = Number(item.dataset.index) === p.selected;
    item.classList.toggle('selected', on);
    item.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (p.selected === undefined) box.removeAttribute('aria-activedescendant');
  else box.setAttribute('aria-activedescendant', `fp-opt-${p.selected}`);
}

function renderFooter(): void {
  const p = picker!;
  const open = openTarget();
  p.root.querySelector<HTMLButtonElement>('[data-fp="open"]')!.disabled = !open;
  const shown = p.root.querySelector<HTMLElement>('.fp-target')!;
  shown.textContent = open ? t('Opens: {path}', { path: open }) : '';
  shown.title = open ?? '';
  p.root.querySelector<HTMLButtonElement>('[data-fp="new"]')!.disabled = !p.listing || !!p.listing.error || p.loading;
  const form = p.root.querySelector<HTMLElement>('.fp-new')!;
  form.hidden = !p.creating;
  const error = p.root.querySelector<HTMLElement>('.fp-new-error')!;
  error.hidden = !p.creating?.error;
  error.textContent = p.creating?.error ?? '';
  field('.fp-new-name')?.setAttribute('aria-invalid', p.creating?.error ? 'true' : 'false');
  form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = !!p.creating?.busy;
}

function scrollToSelected(): void {
  const p = picker;
  if (p?.selected === undefined) return;
  p.root.querySelector<HTMLElement>(`#fp-opt-${p.selected}`)?.scrollIntoView({ block: 'nearest' });
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

// ---------------------------------------------------------------- events (inside the picker only)

layer.addEventListener('click', (e) => {
  const p = picker;
  if (!p) return;
  const clicked = e.target as HTMLElement;
  // A click on the dimmed window around the picker leaves it open (a folder is never picked by accident).
  const item = clicked.closest<HTMLElement>('.fp-item');
  if (item) {
    select(Number(item.dataset.index));
    return;
  }
  const button = clicked.closest<HTMLElement>('[data-fp]');
  if (!button || (button instanceof HTMLButtonElement && button.disabled)) return;
  const index = Number(button.dataset.index);
  switch (button.dataset.fp) {
    case 'cancel':
      close();
      break;
    case 'open': {
      const path = openTarget();
      if (path) close({ path });
      break;
    }
    case 'system':
      close({});
      break;
    case 'up':
      goUp();
      break;
    case 'back':
      goBack();
      break;
    case 'crumb': {
      const segment = p.listing?.segments[index];
      if (segment) goTo(segment.path);
      break;
    }
    case 'place': {
      const place = p.places[index];
      if (place) goTo(place.path);
      break;
    }
    case 'new':
      startCreating();
      break;
    case 'new-cancel':
      cancelCreating();
      break;
  }
});

layer.addEventListener('dblclick', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.fp-item');
  if (!item || !picker) return;
  select(Number(item.dataset.index));
  openSelected();
});

layer.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).classList.contains('fp-filter')) {
    applyFilter();
    renderSelection();
    renderFooter();
  }
});

layer.addEventListener('change', (e) => {
  const box = e.target as HTMLElement;
  if (!picker || !(box instanceof HTMLInputElement) || !box.classList.contains('fp-hidden-box')) return;
  picker.hidden = box.checked;
  const shown = picker.listing?.path;
  if (shown) {
    list(shown, { remember: false });
    render();
  }
});

layer.addEventListener('submit', (e) => {
  if (!(e.target as HTMLElement).matches('[data-fp-new]')) return;
  e.preventDefault();
  submitCreate();
});

layer.addEventListener('keydown', (e) => {
  const p = picker;
  if (!p || questionOpen()) return;
  const el = e.target as HTMLElement;
  const typing = el instanceof HTMLInputElement && el.type === 'text';
  if (e.key === 'Tab') {
    trapFocus(e);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (el.classList.contains('fp-new-name')) cancelCreating();
    else close();
    return;
  }
  if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    goUp();
    return;
  }
  if (el.classList.contains('fp-path') && e.key === 'Enter') {
    e.preventDefault();
    const value = (el as HTMLInputElement).value.trim();
    if (value) goTo(value);
    return;
  }
  if (el.classList.contains('fp-filter')) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = visibleIndexes()[0];
      if (first !== undefined) select(p.selected !== undefined && visibleIndexes().includes(p.selected) ? p.selected : first);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const visible = visibleIndexes();
      const pick = p.selected !== undefined && visible.includes(p.selected) ? p.selected : visible[0];
      if (pick !== undefined) {
        select(pick, false);
        openSelected();
      }
    }
    return;
  }
  if (el.classList.contains('fp-list')) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      moveSelection(e.key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openSelected();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      goUp();
    }
    return;
  }
  if (e.key === 'Backspace' && !typing) {
    e.preventDefault();
    goUp();
  }
});

/** Tab and Shift+Tab stay inside the picker. */
function trapFocus(e: KeyboardEvent): void {
  const p = picker!;
  const focusable = [...p.root.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter(
    (el) => !(el as HTMLButtonElement).disabled && !el.closest('[hidden]') && el.getClientRects().length > 0,
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !p.root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !p.root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

// Focus that leaves the picker (a click on the backdrop) comes back to it.
document.addEventListener('focusin', (e) => {
  const p = picker;
  if (!p || questionOpen() || p.root.contains(e.target as Node)) return;
  field('.fp-filter')?.focus();
});
