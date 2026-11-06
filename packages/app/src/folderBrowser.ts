import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CreateFolderError, FolderEntryView, FolderListingError, FolderPlaceView, FolderSegment } from './protocol';
import type { FolderBrowser } from './shell';

/** The most subfolders one listing of the folder picker shows. */
export const MAX_FOLDER_ENTRIES = 2000;
/** The longest folder name the picker creates. */
const MAX_NAME = 255;
/** How long a drive or place may take to answer before the picker leaves it out (a disconnected network drive). */
const PLACE_TIMEOUT_MS = 800;

/** One listing as the controller sends it on (the places are added there). */
export interface FolderListing {
  path: string;
  parent?: string;
  segments: FolderSegment[];
  entries: FolderEntryView[];
  truncated: boolean;
  error?: FolderListingError;
}

/** Names Windows gives to devices, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
/** Characters Windows does not allow in a name (the other systems allow them; names stay portable). */
const INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
/** Hidden system folders at the root of a Windows drive (Node has no API for the hidden/system attributes). */
const WINDOWS_ROOT_HIDDEN = new Set(['system volume information', 'recovery', 'config.msi', 'programdata', 'msocache', 'boot', 'documents and settings']);
/** Hidden system folders in a Windows user's own folder. */
const WINDOWS_HOME_HIDDEN = new Set(['appdata']);
/** The hidden junctions Windows keeps for old programs (only hidden when they are links). */
const WINDOWS_LEGACY_JUNCTIONS = new Set([
  'application data',
  'cookies',
  'documents and settings',
  'local settings',
  'my documents',
  'my music',
  'my pictures',
  'my videos',
  'nethood',
  'printhood',
  'recent',
  'sendto',
  'start menu',
  'templates',
]);

/**
 * A folder path from the page, checked: a string, absolute, without NUL, not a Windows device path
 * (\\?\ or \\.\), normalised by path.resolve. Undefined for anything else.
 */
export function checkFolderPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return undefined;
  if (process.platform === 'win32' && /^[\\/]{2}[?.][\\/]/.test(value)) return undefined;
  if (!path.isAbsolute(value)) return undefined;
  return path.resolve(value);
}

/** Why `name` cannot be a new folder's name (the same rules on every system, so names stay portable). */
export function folderNameProblem(name: unknown): CreateFolderError | undefined {
  if (typeof name !== 'string' || !name.trim()) return 'empty';
  if (name.length > MAX_NAME) return 'tooLong';
  if (/[\\/]/.test(name)) return 'separator';
  if (name === '.' || name === '..' || DEVICE_NAME.test(name)) return 'reserved';
  if (INVALID_CHARS.test(name)) return 'invalidChars';
  if (/[. ]$/.test(name)) return 'trailing';
  return undefined;
}

/** The breadcrumb of a folder: its root first, then each folder down to it. */
export function folderSegments(dir: string): FolderSegment[] {
  const root = path.parse(dir).root;
  const segments: FolderSegment[] = [{ name: root, path: root }];
  let current = root;
  for (const part of dir.slice(root.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    segments.push({ name: part, path: current });
  }
  return segments;
}

/**
 * The desktop app's own folder picker: the subfolders of any folder on this machine (never a file
 * name or a file's contents), the usual places to start from, and a new folder in the folder shown.
 */
export class NodeFolderBrowser implements FolderBrowser {
  constructor(readonly home: string = os.homedir()) {}

  /** A folder's subfolders, sorted by name; links (and junctions) to folders are marked. */
  async list(dir: string, options: { hidden: boolean }): Promise<FolderListing> {
    const parentDir = path.dirname(dir);
    const base = { path: dir, ...(parentDir !== dir ? { parent: parentDir } : {}), segments: folderSegments(dir) };
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      return { ...base, entries: [], truncated: false, error: listingError(error) };
    }
    const atRoot = parentDir === dir;
    const inHome = samePath(dir, this.home);
    const found = await Promise.all(
      dirents.map(async (dirent): Promise<FolderEntryView | undefined> => {
        const name = dirent.name;
        const link = dirent.isSymbolicLink();
        if (!options.hidden && hiddenFolder(name, link, atRoot, inHome)) return undefined;
        const full = path.join(dir, name);
        if (dirent.isDirectory()) return { name, path: full };
        if (!link) return undefined;
        // A link is listed when it leads to a folder; a broken one is left out.
        try {
          return (await fs.stat(full)).isDirectory() ? { name, path: full, link: true } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const entries = found.filter((e): e is FolderEntryView => !!e).sort((a, b) => compareNames(a.name, b.name));
    return { ...base, entries: entries.slice(0, MAX_FOLDER_ENTRIES), truncated: entries.length > MAX_FOLDER_ENTRIES };
  }

  /** Where to start: the recent folders, the user's own folders that exist, then the drives or volumes. */
  async places(recent: string[]): Promise<FolderPlaceView[]> {
    const places: FolderPlaceView[] = recent.map((p) => ({ kind: 'recent', name: path.basename(p) || p, path: p }));
    const own = [
      ['home', this.home],
      ['desktop', path.join(this.home, 'Desktop')],
      ['documents', path.join(this.home, 'Documents')],
      ['downloads', path.join(this.home, 'Downloads')],
    ] as const;
    const ownFound = await Promise.all(own.map(async ([kind, p]): Promise<FolderPlaceView | undefined> => ((await isFolder(p)) ? { kind, name: path.basename(p) || p, path: p } : undefined)));
    for (const place of ownFound) if (place) places.push(place);
    if (process.platform === 'win32') {
      // Every drive letter at once; one that does not answer in time (an empty card reader, a
      // disconnected network drive) is left out.
      const letters = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
      const drives = await Promise.all(letters.map(async (root) => ((await isFolder(root)) ? root : undefined)));
      for (const root of drives) if (root) places.push({ kind: 'drive', name: root.slice(0, 2), path: root });
    } else {
      places.push({ kind: 'root', name: '/', path: '/' });
      const mounts = process.platform === 'darwin' ? ['/Volumes'] : ['/mnt', '/media', path.join('/media', path.basename(this.home))];
      for (const dir of mounts) {
        const listing = await withTimeout(this.list(dir, { hidden: false }), undefined);
        for (const entry of listing?.entries ?? []) places.push({ kind: 'volume', name: entry.name, path: entry.path });
      }
    }
    return places;
  }

  /** A new folder named `name` in `parent` (never its parents, never over something that exists). */
  async create(parent: string, name: string): Promise<{ path: string } | { error: CreateFolderError }> {
    const problem = folderNameProblem(name);
    if (problem) return { error: problem };
    const target = path.join(parent, name);
    // The name must stay one folder inside the parent.
    if (path.dirname(target) !== parent || path.basename(target) !== name) return { error: 'separator' };
    try {
      await fs.mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { error: code === 'EEXIST' ? 'exists' : code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOENT' || code === 'ENOTDIR' ? 'notFound' : 'failed' };
    }
    return { path: target };
  }
}

function listingError(error: unknown): FolderListingError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'notFound';
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  return 'unreadable';
}

function hiddenFolder(name: string, link: boolean, atRoot: boolean, inHome: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (process.platform !== 'win32') return false;
  const lower = name.toLowerCase();
  if (atRoot && (lower.startsWith('$') || WINDOWS_ROOT_HIDDEN.has(lower))) return true;
  if (inHome && WINDOWS_HOME_HIDDEN.has(lower)) return true;
  return link && WINDOWS_LEGACY_JUNCTIONS.has(lower);
}

async function isFolder(p: string): Promise<boolean> {
  const stat = await withTimeout(fs.stat(p), undefined).catch(() => undefined);
  return !!stat?.isDirectory();
}

function withTimeout<T, F>(work: Promise<T>, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PLACE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function compareNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}
