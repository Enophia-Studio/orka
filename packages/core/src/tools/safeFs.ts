import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInside } from '../acp/mapping';

/**
 * File access inside the workspace that never goes through a link leading out of it. Every
 * function here is synchronous from the checks to the last read or write, so nothing else in Orka
 * runs in between.
 */

export type ReadInsideResult = { bytes: Buffer; dev: bigint; ino: bigint } | { error: 'outside' | 'notFound' | 'notFile' | 'tooLarge' };

export type ReplaceInsideResult = { ok: true; before: Buffer } | { ok: false; reason: 'conflict' | 'gone' | 'outside'; hash?: string };

/**
 * The real path of `abs` when it lies inside the workspace, also after following every link on
 * the way (a link whose target does not exist yet counts by its target); undefined otherwise.
 */
export function insideWorkspace(root: string, abs: string): string | undefined {
  if (!isInside(root, abs)) return undefined;
  let real: string;
  try {
    real = realTarget(abs);
  } catch {
    return undefined; // a link loop
  }
  return isInside(realPath(root), real) ? real : undefined;
}

/**
 * Write a file inside the workspace, never through a link that leads out of it. The path is
 * resolved first (a link inside the workspace, such as GEMINI.md -> AGENTS.md, is written through
 * to its target) and the target and its folder must lie inside the workspace right before it is
 * opened. The target is opened without following a link where the system can (O_NOFOLLOW; a FIFO
 * is not waited for), and before anything is written the opened file must be the one the target
 * names (on Windows, which cannot refuse links when opening, not a link or junction) and lie
 * inside the workspace. Synchronous, so nothing else in Orka runs between the checks and the
 * write. False when it was refused: nothing was written (a file that did not exist may be left
 * empty where a folder of its path was swapped for a link between the last check and the open).
 */
export function writeInsideWorkspace(root: string, abs: string, content: string): boolean {
  const { O_WRONLY, O_CREAT, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const realRoot = realPath(root);
  let target: string;
  try {
    target = realTarget(abs);
  } catch {
    return false; // a link loop
  }
  if (!isInside(realRoot, target) || !isInside(realRoot, realPath(path.dirname(target)))) return false;
  let fd: number;
  try {
    fd = fs.openSync(target, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o666);
  } catch (error) {
    // The target became a link (ELOOP; EMLINK on some BSDs).
    if (isLinkError(error)) return false;
    throw error;
  }
  try {
    if (!sameFileInside(fd, target, realRoot)) return false;
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf8');
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read an existing file inside the workspace, with the same checks as writeInsideWorkspace, at
 * most `maxBytes` long. The file is opened read-only without following a link and without
 * waiting on a FIFO, and read through that one handle; a file that grows past `maxBytes` while it
 * is read is refused as too large.
 */
export function readInsideWorkspace(root: string, abs: string, maxBytes: number): ReadInsideResult {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const realRoot = realPath(root);
  const target = insideWorkspace(root, abs);
  if (!target) return { error: 'outside' };
  let fd: number;
  try {
    fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (isLinkError(error)) return { error: 'outside' };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'notFound' };
    if (code === 'EISDIR') return { error: 'notFile' };
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return { error: 'notFile' };
    if (!sameFileInside(fd, target, realRoot)) return { error: 'outside' };
    if (opened.size > BigInt(maxBytes)) return { error: 'tooLarge' };
    const bytes = readAll(fd, maxBytes + 1);
    if (bytes.length > maxBytes) return { error: 'tooLarge' };
    return { bytes, dev: opened.dev, ino: opened.ino };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replace the content of an existing file inside the workspace, only when its current bytes still
 * hash (sha256, hex) to `expectHash`. Never creates a file: a missing one is `gone`. The checks are
 * those of writeInsideWorkspace; the current bytes are read and compared through the same handle
 * that is then written, in place (hard links, permissions and the file's identity are kept; a
 * temporary file renamed over it fails on Windows while another program holds it open).
 * `conflict` carries the hash of what is on disk now.
 */
export function replaceInsideWorkspace(root: string, abs: string, expectHash: string, content: string): ReplaceInsideResult {
  const { O_RDWR, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const realRoot = realPath(root);
  const target = insideWorkspace(root, abs);
  if (!target || !isInside(realRoot, realPath(path.dirname(target)))) return { ok: false, reason: 'outside' };
  let fd: number;
  try {
    fd = fs.openSync(target, O_RDWR | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (isLinkError(error)) return { ok: false, reason: 'outside' };
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { ok: false, reason: 'gone' };
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { ok: false, reason: 'gone' };
    if (!sameFileInside(fd, target, realRoot)) return { ok: false, reason: 'outside' };
    const before = readAll(fd, Infinity);
    const hash = createHash('sha256').update(before).digest('hex');
    if (hash !== expectHash) return { ok: false, reason: 'conflict', hash };
    const data = Buffer.from(content, 'utf8');
    try {
      // Written first, cut after: a failed write (a full disk, a locked range) then never leaves the file empty.
      writeAllAt(fd, data);
      fs.ftruncateSync(fd, data.length);
    } catch (error) {
      // Put the earlier bytes back through the same handle before reporting the failure.
      try {
        writeAllAt(fd, before);
        fs.ftruncateSync(fd, before.length);
      } catch {
        // Nothing more can be done; the first error is the one reported.
      }
      throw error;
    }
    return { ok: true, before };
  } finally {
    fs.closeSync(fd);
  }
}

/** The real path, or the path itself when it cannot be resolved. */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Where a path really leads, also when it does not exist yet: the nearest part of it that exists
 * (a link counts, even one whose target is missing) resolved, the rest appended. A dangling link
 * is followed to its target, as writing through it would. Throws on a link loop.
 */
function realTarget(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`Too many links: ${target}`);
  let probe = target;
  while (!lexists(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const rest = path.relative(probe, target);
  let real: string | undefined;
  try {
    real = fs.realpathSync.native(probe);
  } catch {
    real = undefined;
  }
  if (real !== undefined) return path.join(real, rest);
  // It exists but does not resolve: a link to something missing. Its target counts, relative to the link's real folder.
  const link = fs.readlinkSync(probe);
  const next = path.resolve(fs.realpathSync.native(path.dirname(probe)), link);
  return realTarget(path.join(next, rest), depth + 1);
}

/** The path exists, as a file, a folder or a link (even one whose target is missing). */
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function readLink(p: string): string | undefined {
  try {
    return fs.readlinkSync(p);
  } catch {
    return undefined;
  }
}

/**
 * The open file is a regular file and the very one `target` names (not a link or junction put in
 * its place), and it lies inside the workspace.
 */
function sameFileInside(fd: number, target: string, realRoot: string): boolean {
  const opened = fs.fstatSync(fd, { bigint: true });
  const named = fs.lstatSync(target, { bigint: true });
  if (!opened.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) return false;
  if (!isInside(realRoot, fs.realpathSync.native(target))) return false;
  // Linux tells which file was opened, whatever happened to the path meanwhile.
  return process.platform !== 'linux' || isInside(realRoot, readLink(`/proc/self/fd/${fd}`) ?? realRoot);
}

/** Up to `limit` bytes from the start of the open file. */
function readAll(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total));
    const n = fs.readSync(fd, chunk, 0, chunk.length, total);
    if (n === 0) break;
    chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
    total += n;
  }
  return Buffer.concat(chunks, total);
}

/** All of `data` written to the open file from its start. */
function writeAllAt(fd: number, data: Buffer): void {
  for (let written = 0; written < data.length; ) written += fs.writeSync(fd, data, written, data.length - written, written);
}

/** Opening refused because the path became a link (ELOOP; EMLINK on some BSDs). */
function isLinkError(error: unknown): boolean {
  return ['ELOOP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '');
}
