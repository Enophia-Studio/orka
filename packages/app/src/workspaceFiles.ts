import { IGNORED_DIRS, insideWorkspace, isProbablyBinaryPath, readInsideWorkspace, replaceInsideWorkspace } from '@orka/core';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SKIP_DIRS } from './files';

/** The largest file the editor opens or saves. */
export const MAX_EDITOR_BYTES = 2 * 1024 * 1024;
/** The most entries one folder of the Files tree shows. */
export const MAX_DIR_ENTRIES = 2000;
/** Folders the Files tree shows dimmed and collapsed: dependencies, build output, engine caches. */
export const IGNORED_FOLDERS: ReadonlySet<string> = new Set([...IGNORED_DIRS, ...SKIP_DIRS]);

/** A file's line endings; a file with both (or a lone CR) opens read-only. */
export type Eol = 'lf' | 'crlf' | 'mixed';
/**
 * Why a file cannot be opened. `unreadable`: the system refused to read it (permissions, or
 * another program holds it locked).
 */
export type FileReason = 'outside' | 'notFound' | 'notFile' | 'tooLarge' | 'binary' | 'encoding' | 'unreadable';
/**
 * Why a save was refused. `conflict`: the file changed on disk since it was read; `gone`: it no
 * longer exists; `readOnly`: it has mixed line endings; `invalid`: a malformed request;
 * `unwritable`: the system refused the write.
 */
export type SaveRefusal = 'conflict' | 'gone' | 'tooLarge' | 'outside' | 'readOnly' | 'invalid' | 'unwritable';

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
  /** A link (or junction) to a place inside the workspace. */
  link?: true;
  /** A dependency or build folder, shown dimmed. */
  ignored?: true;
}

export type DirListing = { entries: DirEntry[]; truncated: boolean } | { error: 'outside' | 'notFound' };

/**
 * A file as the editor gets it: the text with `\n` line breaks and without a UTF-8 BOM, and the
 * sha256 of the bytes on disk. `unchanged` when the caller already has the bytes with that hash.
 */
export type FileRead =
  | { text: string; hash: string; size: number; eol: Eol; bom: boolean; readOnly?: true }
  | { unchanged: true; hash: string }
  | { error: FileReason };

/** `before` and `after` are the file's full texts, BOM and CR included, as Orka's file reads return them. */
export type SaveResult = { ok: true; hash: string; before: string; after: string } | { ok: false; reason: SaveRefusal; hash?: string };

const HASH = /^[0-9a-f]{64}$/;
/** Names Windows gives to devices, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

/**
 * The open folder's files for the desktop app's editor: a lazy tree, and reads and saves of
 * existing UTF-8 text files. Paths come from the page, workspace-relative with forward slashes,
 * and are checked here: nothing outside the folder (also through a link or junction) and nothing
 * in .git is listed, read or written, and a save never creates a file.
 */
export class WorkspaceFiles {
  constructor(readonly root: string) {}

  /**
   * A workspace-relative path checked and resolved: `abs` is the path inside the folder as written
   * (how Orka's change tracking names the file), `real` where it leads after every link.
   * Undefined for a path that is malformed, names something in .git or leads out of the folder.
   */
  resolve(rel: string): { rel: string; abs: string; real: string } | undefined {
    return this.check(rel, false);
  }

  /** One folder's entries (`''` is the folder itself): folders first, then by name. */
  list(rel: string): DirListing {
    const dir = this.check(rel, true);
    if (!dir) return { error: 'outside' };
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir.real, { withFileTypes: true });
    } catch {
      return { error: 'notFound' };
    }
    // The folder may have been swapped for a link while it was read.
    if (!insideWorkspace(this.root, dir.real)) return { error: 'outside' };
    const entries: DirEntry[] = [];
    for (const dirent of dirents) {
      const name = dirent.name;
      if (name.toLowerCase() === '.git') continue;
      let kind: DirEntry['kind'] | undefined;
      let link = false;
      if (dirent.isDirectory()) kind = 'dir';
      else if (dirent.isFile()) kind = 'file';
      else if (dirent.isSymbolicLink()) {
        // Only a link that stays inside the folder (and out of .git) is listed, as what it leads to.
        const target = this.check(dir.rel ? `${dir.rel}/${name}` : name, false);
        if (!target) continue;
        try {
          const stat = fs.statSync(target.real);
          kind = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
        } catch {
          kind = undefined; // its target is missing
        }
        link = true;
      }
      if (!kind) continue;
      entries.push({ name, kind, ...(link ? { link: true as const } : {}), ...(kind === 'dir' && IGNORED_FOLDERS.has(name) ? { ignored: true as const } : {}) });
    }
    entries.sort((a, b) => (a.kind === b.kind ? compareNames(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
    return { entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: entries.length > MAX_DIR_ENTRIES };
  }

  /** Read a text file for the editor. With `knownHash` equal to the file's hash, no text is returned. */
  read(rel: string, knownHash?: string): FileRead {
    const file = this.resolve(rel);
    if (!file) return { error: 'outside' };
    if (isProbablyBinaryPath(file.rel)) return { error: 'binary' };
    const bytes = this.readBytes(file.abs);
    if ('error' in bytes) return bytes;
    const hash = sha256(bytes.bytes);
    if (knownHash === hash) return { unchanged: true, hash };
    const decoded = decode(bytes.bytes);
    if ('error' in decoded) return decoded;
    const { text, eol, bom } = decoded;
    const body = bom ? text.slice(1) : text;
    return { text: body.replace(/\r\n?/g, '\n'), hash, size: bytes.bytes.length, eol, bom, ...(eol === 'mixed' ? { readOnly: true as const } : {}) };
  }

  /**
   * Save the editor's text over the file, only when the file on disk still hashes to `baseHash`.
   * The line endings and the BOM are taken from the bytes on disk, not from the page, and the hash
   * is checked again under the same handle that writes.
   */
  save(rel: string, text: string, baseHash: string): SaveResult {
    if (typeof text !== 'string' || typeof baseHash !== 'string' || !HASH.test(baseHash)) return { ok: false, reason: 'invalid' };
    const file = this.resolve(rel);
    if (!file) return { ok: false, reason: 'outside' };
    if (isProbablyBinaryPath(file.rel)) return { ok: false, reason: 'invalid' };
    if (Buffer.byteLength(text, 'utf8') > MAX_EDITOR_BYTES) return { ok: false, reason: 'tooLarge' };
    const disk = this.readBytes(file.abs);
    if ('error' in disk) {
      const reason = ({ outside: 'outside', notFound: 'gone', notFile: 'gone', tooLarge: 'tooLarge', unreadable: 'unwritable' } as const)[disk.error];
      return { ok: false, reason };
    }
    const hash = sha256(disk.bytes);
    if (hash !== baseHash) return { ok: false, reason: 'conflict', hash };
    const decoded = decode(disk.bytes);
    if ('error' in decoded) return { ok: false, reason: 'invalid' };
    if (decoded.eol === 'mixed') return { ok: false, reason: 'readOnly' };
    let content = text.replace(/\r\n?/g, '\n');
    if (decoded.eol === 'crlf') content = content.replace(/\n/g, '\r\n');
    if (decoded.bom) content = `﻿${content}`;
    const data = Buffer.from(content, 'utf8');
    if (data.length > MAX_EDITOR_BYTES) return { ok: false, reason: 'tooLarge' };
    let result: ReturnType<typeof replaceInsideWorkspace>;
    try {
      result = replaceInsideWorkspace(this.root, file.abs, baseHash, content);
    } catch {
      return { ok: false, reason: 'unwritable' };
    }
    if (!result.ok) return { ok: false, reason: result.reason, ...(result.hash ? { hash: result.hash } : {}) };
    return { ok: true, hash: sha256(data), before: result.before.toString('utf8'), after: content };
  }

  private check(rel: string, allowRoot: boolean): { rel: string; abs: string; real: string } | undefined {
    if (typeof rel !== 'string' || rel.length > 1024 || /[\0:\\]/.test(rel)) return undefined;
    if (rel === '' && !allowRoot) return undefined;
    const segments = rel === '' ? [] : rel.split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git') return undefined;
      if (process.platform === 'win32' && (DEVICE_NAME.test(segment) || /[. ]$/.test(segment))) return undefined;
    }
    const abs = segments.length ? path.join(this.root, ...segments) : this.root;
    const real = insideWorkspace(this.root, abs);
    if (!real) return undefined;
    // A link inside the folder must not lead into .git either.
    const realRoot = insideWorkspace(this.root, this.root) ?? this.root;
    if (path.relative(realRoot, real).split(path.sep).some((s) => s.toLowerCase() === '.git')) return undefined;
    return { rel, abs, real };
  }

  private readBytes(abs: string): { bytes: Buffer } | { error: 'outside' | 'notFound' | 'notFile' | 'tooLarge' | 'unreadable' } {
    try {
      const read = readInsideWorkspace(this.root, abs, MAX_EDITOR_BYTES);
      return 'error' in read ? read : { bytes: read.bytes };
    } catch {
      return { error: 'unreadable' };
    }
  }
}

/** The file's text as it is on disk (BOM and CRs kept), its line endings and whether it starts with a UTF-8 BOM. */
function decode(bytes: Buffer): { text: string; eol: Eol; bom: boolean } | { error: 'binary' | 'encoding' } {
  // UTF-16 (and UTF-32 LE) byte order marks; such text is full of NUL bytes, so this comes first.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return { error: 'encoding' };
  if (bytes.subarray(0, 8000).includes(0)) return { error: 'binary' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { error: 'encoding' };
  }
  const bom = text.startsWith('﻿');
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  const cr = (body.match(/\r(?!\n)/g) ?? []).length;
  const eol: Eol = cr || (crlf && lf) ? 'mixed' : crlf ? 'crlf' : 'lf';
  return { text, eol, bom };
}

function compareNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
