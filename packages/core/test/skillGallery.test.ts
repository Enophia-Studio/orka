import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { TR } from '../src/i18n/tr';
import { galleryEntry, galleryStrings, openLicense, SKILL_GALLERY, SKILL_GALLERY_CATEGORIES } from '../src/skills/gallery';
import { GALLERY_SOURCES, type GallerySource } from '../src/skills/galleryFiles';
import {
  downloadLimited,
  GALLERY_MANIFEST,
  galleryInstallPlan,
  installBundledSkill,
  installGallerySkill,
  installSourceSkill,
  MAX_GALLERY_FILE_BYTES,
  rawUrl,
  readGalleryManifest,
  removeGallerySkill,
  safeRelativePath,
  sourceProblem,
} from '../src/skills/galleryInstall';
import { loadSkills, parseSkill, SKILL_NAME } from '../src/skills/Skills';
import { tempWorkspace } from './helpers';

const CORE_ROOT = path.resolve(__dirname, '../..');
const BUILTIN_SKILLS = path.join(CORE_ROOT, 'skills');
const GALLERY = path.join(BUILTIN_SKILLS, 'gallery');

describe('skills gallery data', () => {
  it('has unique skill-name ids that do not shadow a built-in skill, known categories and https pages', async () => {
    const builtin = (await loadSkills([{ dir: BUILTIN_SKILLS, source: 'builtin' }])).skills.map((s) => s.name);
    assert.ok(SKILL_GALLERY.length >= 60, `${SKILL_GALLERY.length} entries`);
    const ids = new Set<string>();
    for (const e of SKILL_GALLERY) {
      assert.match(e.id, SKILL_NAME, e.id);
      assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
      ids.add(e.id);
      assert.ok(!builtin.includes(e.id), `${e.id} would replace a built-in skill`);
      assert.ok(SKILL_GALLERY_CATEGORIES.includes(e.category), e.id);
      assert.ok(e.name && e.description && e.author && e.needs.length, e.id);
      assert.match(e.source, /^https:\/\/github\.com\//, e.id);
    }
    assert.equal(galleryEntry('docx')?.kind, 'source');
    assert.equal(galleryEntry('nope'), undefined);
    assert.equal(galleryEntry(42), undefined);
  });

  it('ships only openly licensed skills, and marks every other licence before it is installed', () => {
    for (const e of SKILL_GALLERY) {
      if (e.kind === 'bundled') assert.ok(openLicense(e.license), `${e.id} is bundled under ${e.license}`);
      if (!openLicense(e.license)) assert.ok(e.licenseNote, `${e.id} (${e.license}) needs a licence note`);
    }
    // Proprietary skills are neither shipped nor offered.
    assert.equal(galleryEntry('claude-security'), undefined);
    assert.equal(galleryEntry('doc-coauthoring')?.kind, 'source');
    assert.ok(SKILL_GALLERY.filter((e) => e.license.startsWith('LicenseRef-Unity')).every((e) => e.kind === 'source'));
    assert.ok(SKILL_GALLERY.filter((e) => e.license === 'CC-BY-SA-4.0').every((e) => e.kind === 'source'));
  });

  it('has every bundled skill on disk with its licence and NOTICE, and nothing else in the gallery folder', async () => {
    const bundled = SKILL_GALLERY.filter((e) => e.kind === 'bundled').map((e) => e.id).sort();
    const onDisk = readdirSync(GALLERY, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    assert.deepEqual(onDisk, bundled);
    const { skills, errors } = await loadSkills([{ dir: GALLERY, source: 'builtin' }]);
    assert.deepEqual(errors, []);
    for (const id of bundled) {
      const dir = path.join(GALLERY, id);
      const files = readdirSync(dir);
      assert.ok(files.some((f) => /^licen[cs]e(\.\w+)?$/i.test(f)), `${id} has a licence file`);
      const notice = readFileSync(path.join(dir, 'NOTICE'), 'utf8');
      const entry = galleryEntry(id)!;
      if (entry.author === 'Orka') assert.match(notice, /original skill written for the Orka skills gallery/);
      else {
        // Third-party: source at a pinned commit, copyright and Orka's changes.
        assert.match(notice, /^Source: https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-f]{40}\//m, id);
        assert.match(notice, /Copyright \(c\)/, id);
        assert.match(notice, /Changes made for Orka/, id);
      }
      const skill = skills.find((s) => s.name === id);
      assert.ok(skill && skill.description.length > 30 && skill.body.length > 300, id);
      assert.match(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), new RegExp(`^license: ${entry.license.replace('.', '\\.')}$`, 'm'), id);
    }
  });

  it('has a valid, pinned download list for every downloadable skill and for nothing else', () => {
    const downloads = SKILL_GALLERY.filter((e) => e.kind === 'source').map((e) => e.id).sort();
    assert.deepEqual(Object.keys(GALLERY_SOURCES).sort(), downloads);
    for (const id of downloads) {
      assert.equal(sourceProblem(GALLERY_SOURCES[id]), undefined, id);
      const plan = galleryInstallPlan(id)!;
      assert.ok(plan.urls.every((u) => u.startsWith(`https://raw.githubusercontent.com/${GALLERY_SOURCES[id].repo}/${GALLERY_SOURCES[id].ref}/`)), id);
      // A downloaded skill keeps its licence text.
      if (galleryEntry(id)!.license !== 'NOASSERTION') assert.ok(GALLERY_SOURCES[id].files.some((f) => /^licen[cs]e(\.\w+)?$/i.test(f.to)), `${id} has a licence file`);
    }
    assert.equal(galleryInstallPlan('frontend-design'), undefined, 'a bundled skill downloads nothing');
  });

  it('has a Turkish text for every description, need and note', () => {
    const missing = galleryStrings().filter((s) => !(s in TR));
    assert.deepEqual(missing, [], `missing Turkish translations:\n${missing.join('\n')}`);
  });

  it('reads YAML block descriptions, as published skills write them', () => {
    const folded = parseSkill('---\nname: ui-uitk\ndescription: >\n  Reads and edits\n  UXML layouts.\nlicense: x\n---\nBody', 'x');
    assert.deepEqual(folded, { name: 'ui-uitk', description: 'Reads and edits UXML layouts.', body: 'Body' });
    const literal = parseSkill('---\ndescription: |-\n  One\n\n  two\nname: a\n---\nBody', 'x');
    assert.ok(!('error' in literal) && literal.description === 'One two' && literal.name === 'a');
    assert.deepEqual(parseSkill('---\nname: a\ndescription: >\n---\nBody', 'x'), { error: 'missing "description" in the front matter' });
  });

  it('only accepts plain relative paths', () => {
    for (const ok of ['SKILL.md', 'references/a-b.md', 'scripts/__init__.py', 'ooxml/schemas/x.xsd']) assert.ok(safeRelativePath(ok), ok);
    for (const bad of ['', '../x.md', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', '.git/config', 'a/.', 'con', 'nul.txt', 'x.', 'a b', 'a/b/c/d/e/f/g/h/i']) {
      assert.ok(!safeRelativePath(bad), bad);
    }
    assert.equal(rawUrl('o/r', 'a'.repeat(40), 'skills/x/SKILL.md'), `https://raw.githubusercontent.com/o/r/${'a'.repeat(40)}/skills/x/SKILL.md`);
  });
});

// ---------------------------------------------------------------- installing

const REF = 'b'.repeat(40);
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const SKILL = '---\nname: demo-skill\ndescription: A demo skill used to test the gallery installer.\n---\n# Demo\n\nSee references/more.md.';
const MORE = 'More details.';
const LICENSE = 'MIT License\n\nCopyright (c) test';

function source(files: Record<string, string>, extra: Partial<GallerySource> = {}): GallerySource {
  return {
    repo: 'someone/skills',
    ref: REF,
    files: Object.entries(files).map(([to, text]) => ({ from: `skills/demo/${to}`, to, size: Buffer.byteLength(text), sha256: sha(text) })),
    ...extra,
  };
}

describe('gallery installer', () => {
  let server: Server;
  let base: string;
  /** Served bodies by path ("/someone/skills/<ref>/skills/demo/SKILL.md"). */
  const bodies = new Map<string, string | { redirect: string } | { length: number; send: string }>();
  const requests: string[] = [];
  let ws: ReturnType<typeof tempWorkspace>;

  before(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      const body = bodies.get(req.url ?? '');
      if (body === undefined) return void res.writeHead(404).end('missing');
      if (typeof body === 'object' && 'redirect' in body) return void res.writeHead(302, { location: body.redirect }).end();
      if (typeof body === 'object') {
        // Declares one length and sends more (chunked): the reader must stop at the limit.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body.send);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    ws = tempWorkspace();
    bodies.clear();
    requests.length = 0;
  });
  afterEach(() => ws.cleanup());

  /** The installer's download, pointed at the fake server instead of GitHub. */
  const local = (url: string, maxBytes: number) =>
    downloadLimited(url.replace('https://raw.githubusercontent.com', base), maxBytes, { allow: (u) => u.hostname === '127.0.0.1' });
  const serve = (src: GallerySource, texts: Record<string, string>) => {
    for (const f of src.files) bodies.set(`/${src.repo}/${src.ref}/${f.from}`, texts[f.to]);
  };
  const entry = { id: 'demo-skill', license: 'MIT', source: 'https://github.com/someone/skills' };

  it('downloads exactly the listed files into the skills folder, with a manifest, and the skill loads', async () => {
    const texts = { 'SKILL.md': SKILL, 'references/more.md': MORE, LICENSE };
    const src = source(texts);
    serve(src, texts);
    const skills = path.join(ws.root, 'skills');
    const manifest = await installSourceSkill(entry, src, skills, { download: local });
    assert.deepEqual(manifest.files, ['SKILL.md', 'references/more.md', 'LICENSE']);
    assert.equal(manifest.ref, REF);
    assert.equal(readFileSync(path.join(skills, 'demo-skill', 'references', 'more.md'), 'utf8'), MORE);
    assert.deepEqual(await readGalleryManifest(path.join(skills, 'demo-skill')), manifest);
    assert.deepEqual(readdirSync(skills), ['demo-skill'], 'no leftover download folder');
    const loaded = await loadSkills([{ dir: skills, source: 'user' }]);
    assert.deepEqual(loaded.skills.map((s) => s.name), ['demo-skill']);
    assert.equal(requests.length, 3);
    // Installed once: a second install is refused before any download.
    await assert.rejects(installSourceSkill(entry, src, skills, { download: local }), /already has "demo-skill"/);
    assert.equal(requests.length, 3);
  });

  it('refuses a file whose contents differ from the list and leaves nothing behind', async () => {
    const src = source({ 'SKILL.md': SKILL, LICENSE });
    serve(src, { 'SKILL.md': SKILL.replace('demo', 'evil'), LICENSE });
    const skills = path.join(ws.root, 'skills');
    await assert.rejects(installSourceSkill(entry, src, skills, { download: local }), /different (size|contents) than expected/);
    assert.deepEqual(readdirSync(skills), []);
  });

  it('refuses path traversal and unlisted shapes before downloading anything', async () => {
    const skills = path.join(ws.root, 'skills');
    for (const to of ['../outside.md', '..\\outside.md', '/abs.md', 'C:/x.md', 'a/../../b.md']) {
      const src = source({ 'SKILL.md': SKILL });
      src.files.push({ from: 'skills/demo/x.md', to, size: 1, sha256: sha('x') });
      await assert.rejects(installSourceSkill(entry, src, skills, { download: local }), /unsafe path/, to);
    }
    await assert.rejects(installSourceSkill(entry, source({ 'README.md': 'x' }), skills, { download: local }), /no SKILL\.md/);
    await assert.rejects(installSourceSkill(entry, source({ 'SKILL.md': SKILL }, { ref: 'main' }), skills, { download: local }), /bad commit/);
    await assert.rejects(installSourceSkill({ ...entry, id: '../x' }, source({ 'SKILL.md': SKILL }), skills, { download: local }), /not a skill name/);
    const big = source({ 'SKILL.md': SKILL });
    big.files[0].size = MAX_GALLERY_FILE_BYTES + 1;
    await assert.rejects(installSourceSkill(entry, big, skills, { download: local }), /too big/);
    assert.deepEqual(requests, []);
    assert.ok(!existsSync(path.join(ws.root, 'outside.md')));
  });

  it('stops reading a body that grows past the expected size, and refuses redirects, other hosts and plain http', async () => {
    bodies.set('/long', { length: 10, send: 'x'.repeat(5000) });
    await assert.rejects(downloadLimited(`${base}/long`, 10, { allow: () => true }), /bigger than expected/);
    bodies.set('/declared', 'y'.repeat(100));
    await assert.rejects(downloadLimited(`${base}/declared`, 10, { allow: () => true }), /bigger than expected/);
    bodies.set('/moved', { redirect: `${base}/declared` });
    await assert.rejects(downloadLimited(`${base}/moved`, 1000, { allow: () => true }));
    await assert.rejects(downloadLimited(`${base}/missing`, 1000, { allow: () => true }), /404/);
    // Without a test hook only https://raw.githubusercontent.com/ is allowed, checked before connecting.
    const before = requests.length;
    await assert.rejects(downloadLimited(`${base}/declared`, 1000), /only from https:\/\/raw\.githubusercontent\.com/);
    await assert.rejects(downloadLimited('http://raw.githubusercontent.com/o/r/x', 1000), /only from/);
    await assert.rejects(downloadLimited('https://raw.githubusercontent.com.evil.test/o/r/x', 1000), /only from/);
    await assert.rejects(downloadLimited('https://user@raw.githubusercontent.com/o/r/x', 1000), /only from/);
    assert.equal(requests.length, before);
    // A size cap on an installer list: the file is fetched with its listed size as the limit.
    const src = source({ 'SKILL.md': SKILL });
    bodies.set(`/${src.repo}/${src.ref}/${src.files[0].from}`, { length: 0, send: `${SKILL}${'z'.repeat(1000)}` });
    await assert.rejects(installSourceSkill(entry, src, path.join(ws.root, 'skills'), { download: local }), /bigger than expected/);
  });

  it('installs a real catalog entry by its pinned list (served locally)', async () => {
    const src = GALLERY_SOURCES['ui-ugui'];
    // Bodies that match the real checksums are not available offline, so the first file fails the check.
    await assert.rejects(installGallerySkill('ui-ugui', path.join(ws.root, 'skills'), { download: async (_u, max) => new Uint8Array(Math.min(max, 1)) }), /different/);
    assert.ok(src.files.some((f) => f.to === 'LICENSE.md'));
    await assert.rejects(installGallerySkill('frontend-design', path.join(ws.root, 'skills')), /not a downloadable/);
  });

  it('copies a bundled skill with its licence and NOTICE, and removes only gallery folders', async () => {
    const skills = path.join(ws.root, 'skills');
    const manifest = await installBundledSkill('systematic-debugging', GALLERY, skills);
    const dir = path.join(skills, 'systematic-debugging');
    for (const file of ['SKILL.md', 'LICENSE', 'NOTICE', 'find-polluter.sh', GALLERY_MANIFEST]) assert.ok(existsSync(path.join(dir, file)), file);
    assert.equal(manifest.kind, 'bundled');
    assert.equal(manifest.license, 'MIT');
    assert.ok(manifest.files.includes('NOTICE'));
    await assert.rejects(installBundledSkill('systematic-debugging', GALLERY, skills), /already has/);
    await assert.rejects(installBundledSkill('docx', GALLERY, skills), /not a bundled/);
    // A folder of the user's own (no manifest) is never removed from the gallery.
    mkdirSync(path.join(skills, 'mine'));
    writeFileSync(path.join(skills, 'mine', 'SKILL.md'), '---\ndescription: mine\n---\nx');
    assert.equal(await removeGallerySkill(skills, 'mine'), false);
    assert.equal(await removeGallerySkill(skills, '../skills'), false);
    assert.ok(existsSync(path.join(skills, 'mine', 'SKILL.md')));
    assert.equal(await removeGallerySkill(skills, 'systematic-debugging'), true);
    assert.ok(!existsSync(dir));
  });

  it('skips hidden folders when loading skills (a download in progress)', async () => {
    const skills = path.join(ws.root, 'skills');
    mkdirSync(path.join(skills, '.demo.installing-1234'), { recursive: true });
    writeFileSync(path.join(skills, '.demo.installing-1234', 'SKILL.md'), SKILL);
    const loaded = await loadSkills([{ dir: skills, source: 'user' }]);
    assert.deepEqual(loaded.skills, []);
    assert.deepEqual(loaded.errors, []);
  });
});
