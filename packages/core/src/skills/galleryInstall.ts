import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { galleryEntry, type SkillGalleryEntry } from './gallery';
import { GALLERY_SOURCES, type GallerySource } from './galleryFiles';
import { parseSkill, SKILL_NAME } from './Skills';

/**
 * Installs gallery skills into the user's skills folder:
 * - a bundled skill is copied from Orka's own skills/gallery folder;
 * - a downloadable one is fetched file by file over HTTPS from raw.githubusercontent.com at its
 *   pinned commit. Only the files listed in galleryFiles.ts are fetched, each one must have exactly
 *   the listed size and SHA-256, and paths are checked so nothing lands outside the skill's folder.
 *   The files are written to a hidden folder first and moved into place only when all of them
 *   passed. Nothing downloaded is ever run.
 *
 * Every installed skill gets a manifest (GALLERY_MANIFEST) naming its origin, which the UI shows and
 * which marks the folder as removable from the gallery.
 */
export const GALLERY_MANIFEST = '.orka-gallery.json';
export const RAW_HOST = 'raw.githubusercontent.com';
export const MAX_GALLERY_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_GALLERY_SKILL_BYTES = 8 * 1024 * 1024;
export const MAX_GALLERY_FILES = 150;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface GalleryManifest {
  id: string;
  kind: 'bundled' | 'source';
  license: string;
  /** The skill's page upstream. */
  source: string;
  /** Downloaded skills: owner/name and the commit. */
  repo?: string;
  ref?: string;
  /** The files written, relative to the skill folder. */
  files: string[];
  installedAt: string;
}

/** Fetches a URL into memory, refusing more than maxBytes. */
export type GalleryDownload = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;

// Windows device names, which cannot be file names in any folder.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** A plain relative path ("references/a.md"): no "..", no absolute or drive path, no odd characters. */
export function safeRelativePath(file: string): boolean {
  if (typeof file !== 'string' || !file || file.length > 240) return false;
  const parts = file.split('/');
  if (parts.length > 8) return false;
  return parts.every((p) => SEGMENT.test(p) && !p.endsWith('.') && !RESERVED.test(p));
}

export function rawUrl(repo: string, ref: string, file: string): string {
  return `https://${RAW_HOST}/${repo}/${ref}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/** Why a download list cannot be used, or undefined when it can. */
export function sourceProblem(source: GallerySource): string | undefined {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo)) return `bad repository "${source.repo}"`;
  if (!/^[0-9a-f]{40}$/.test(source.ref)) return `bad commit "${source.ref}"`;
  if (!source.files.length || source.files.length > MAX_GALLERY_FILES) return `${source.files.length} files (at most ${MAX_GALLERY_FILES})`;
  const seen = new Set<string>();
  let total = 0;
  for (const f of source.files) {
    if (!safeRelativePath(f.from) || !safeRelativePath(f.to)) return `unsafe path "${f.to}"`;
    if (seen.has(f.to.toLowerCase())) return `"${f.to}" twice`;
    seen.add(f.to.toLowerCase());
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_GALLERY_FILE_BYTES) return `"${f.to}" is too big`;
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) return `"${f.to}" has no checksum`;
    total += f.size;
  }
  if (total > MAX_GALLERY_SKILL_BYTES) return 'the skill is too big';
  if (!seen.has('skill.md')) return 'no SKILL.md';
  return undefined;
}

export interface GalleryPlan {
  entry: SkillGalleryEntry;
  source: GallerySource;
  /** Every URL that will be fetched, in order. */
  urls: string[];
  bytes: number;
}

/** What installing a downloadable gallery skill fetches. */
export function galleryInstallPlan(id: string): GalleryPlan | undefined {
  const entry = galleryEntry(id);
  const source = GALLERY_SOURCES[id];
  if (!entry || entry.kind !== 'source' || !source || sourceProblem(source)) return undefined;
  return { entry, source, urls: source.files.map((f) => rawUrl(source.repo, source.ref, f.from)), bytes: source.files.reduce((n, f) => n + f.size, 0) };
}

/**
 * Fetches a URL into memory: only https://raw.githubusercontent.com/ (or what `allow` accepts, for
 * tests), no redirects, at most maxBytes (the body is cut off as soon as it grows past that).
 */
export async function downloadLimited(url: string, maxBytes: number, options: { allow?: (url: URL) => boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const target = new URL(url);
  const allowed = options.allow
    ? options.allow(target)
    : target.protocol === 'https:' && target.hostname === RAW_HOST && !target.port && !target.username && !target.password;
  if (!allowed) throw new Error(`Downloads come only from https://${RAW_HOST}/, not ${target.origin}.`);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(target, { redirect: 'error', signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${target.href}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${target.href} is bigger than expected.`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${target.href} is bigger than expected.`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const defaultDownload: GalleryDownload = (url, maxBytes, signal) => downloadLimited(url, maxBytes, { signal });

/** A file path inside dir, or an error when it would land outside it. */
function inside(dir: string, file: string): string {
  const target = path.resolve(dir, ...file.split('/'));
  const relative = path.relative(dir, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`"${file}" would be written outside the skill folder.`);
  return target;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Writes into a hidden folder next to the target, then moves it into place; removes it on failure. */
async function intoPlace(skillsDir: string, id: string, fill: (dir: string) => Promise<string[]>, manifest: Omit<GalleryManifest, 'files' | 'installedAt'>): Promise<GalleryManifest> {
  if (!SKILL_NAME.test(id)) throw new Error(`"${id}" is not a skill name.`);
  const target = path.join(skillsDir, id);
  if (await exists(target)) throw new Error(`Your skills folder already has "${id}".`);
  await fs.mkdir(skillsDir, { recursive: true });
  // A dot folder: the skill loader skips it while it is being filled.
  const temp = path.join(skillsDir, `.${id}.installing-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(temp);
  try {
    const files = await fill(temp);
    const skill = await fs.readFile(path.join(temp, 'SKILL.md'), 'utf8');
    const parsed = parseSkill(skill, id);
    if ('error' in parsed) throw new Error(`Not a usable skill: ${parsed.error}.`);
    const full: GalleryManifest = { ...manifest, files, installedAt: new Date().toISOString() };
    await fs.writeFile(path.join(temp, GALLERY_MANIFEST), `${JSON.stringify(full, null, 2)}\n`, { flag: 'wx' });
    if (await exists(target)) throw new Error(`Your skills folder already has "${id}".`);
    await fs.rename(temp, target);
    return full;
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
}

/** Downloads a skill from its pinned file list into skillsDir/<id>. */
export async function installSourceSkill(
  entry: Pick<SkillGalleryEntry, 'id' | 'license' | 'source'>,
  source: GallerySource,
  skillsDir: string,
  options: { download?: GalleryDownload; signal?: AbortSignal } = {},
): Promise<GalleryManifest> {
  const problem = sourceProblem(source);
  if (problem) throw new Error(`The download list of ${entry.id} cannot be used: ${problem}.`);
  const download = options.download ?? defaultDownload;
  return intoPlace(
    skillsDir,
    entry.id,
    async (dir) => {
      for (const file of source.files) {
        const url = rawUrl(source.repo, source.ref, file.from);
        const data = await download(url, file.size, options.signal);
        if (data.byteLength !== file.size) throw new Error(`${url} has a different size than expected.`);
        if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`${url} has different contents than expected.`);
        const target = inside(dir, file.to);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data, { flag: 'wx' });
      }
      return source.files.map((f) => f.to);
    },
    { id: entry.id, kind: 'source', license: entry.license, source: entry.source, repo: source.repo, ref: source.ref },
  );
}

/** Downloads a gallery skill by id. */
export async function installGallerySkill(id: string, skillsDir: string, options: { download?: GalleryDownload; signal?: AbortSignal } = {}): Promise<GalleryManifest> {
  const entry = galleryEntry(id);
  const source = GALLERY_SOURCES[id];
  if (!entry || entry.kind !== 'source' || !source) throw new Error(`"${id}" is not a downloadable gallery skill.`);
  return installSourceSkill(entry, source, skillsDir, options);
}

/** Copies a bundled gallery skill (galleryDir/<id>) into skillsDir/<id>. */
export async function installBundledSkill(id: string, galleryDir: string, skillsDir: string): Promise<GalleryManifest> {
  const entry = galleryEntry(id);
  if (!entry || entry.kind !== 'bundled') throw new Error(`"${id}" is not a bundled gallery skill.`);
  const from = path.join(galleryDir, id);
  return intoPlace(
    skillsDir,
    id,
    async (dir) => {
      await fs.cp(from, dir, { recursive: true, errorOnExist: true, force: false });
      return (await listFiles(dir)).sort();
    },
    { id, kind: 'bundled', license: entry.license, source: entry.source },
  );
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/** The gallery manifest of an installed skill folder, if it has a valid one. */
export async function readGalleryManifest(dir: string): Promise<GalleryManifest | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, GALLERY_MANIFEST), 'utf8')) as Partial<GalleryManifest>;
    if (typeof data.id !== 'string' || !SKILL_NAME.test(data.id) || (data.kind !== 'bundled' && data.kind !== 'source')) return undefined;
    return {
      id: data.id,
      kind: data.kind,
      license: typeof data.license === 'string' ? data.license : '',
      source: typeof data.source === 'string' && data.source.startsWith('https://') ? data.source : '',
      repo: typeof data.repo === 'string' ? data.repo : undefined,
      ref: typeof data.ref === 'string' ? data.ref : undefined,
      files: Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === 'string') : [],
      installedAt: typeof data.installedAt === 'string' ? data.installedAt : '',
    };
  } catch {
    return undefined;
  }
}

/** Removes skillsDir/<name> when it was installed from the gallery (it has a manifest). */
export async function removeGallerySkill(skillsDir: string, name: string): Promise<boolean> {
  if (!SKILL_NAME.test(name)) return false;
  const dir = path.join(skillsDir, name);
  if (!(await readGalleryManifest(dir))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}
