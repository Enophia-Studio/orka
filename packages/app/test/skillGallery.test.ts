// Settings > Skills > Gallery: the page's HTML, and the app adding skills (copied, or downloaded
// only after consent) and removing them.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { galleryEntry } from '@orka/core/src/skills/gallery';
import { AppController } from '../src/AppController';
import type { SkillView } from '../src/protocol';
import { filterGallery, galleryHtml, galleryListHtml, galleryPreviewHtml, type GalleryState, installedEntries, originLabel } from '../webview/features/skillGallery';
import { FakeShell } from './fakeShell';

const GALLERY = path.resolve(__dirname, '../../../core/skills/gallery');
const state = (patch: Partial<GalleryState> = {}): GalleryState => ({ query: '', category: '', license: '', open: new Set(), ...patch });
const skill = (name: string, origin?: SkillView['origin']): SkillView => ({ name, description: 'd', source: 'user', enabled: true, ...(origin ? { origin } : {}) });
const row = (html: string, id: string) => html.split('data-entry="').find((part) => part.startsWith(`${id}"`))!;

describe('skills gallery page', () => {
  it('searches names, authors and descriptions, filters by category and licence, and lists included skills first', () => {
    assert.ok(filterGallery(state({ query: 'unreal' })).some((e) => e.id === 'unreal-engine'));
    assert.ok(filterGallery(state({ query: 'trail of bits' })).every((e) => e.license === 'CC-BY-SA-4.0'));
    const game = filterGallery(state({ category: 'game-dev' }));
    assert.ok(game.length > 5 && game.every((e) => e.category === 'game-dev'));
    const kinds = game.map((e) => e.kind);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => Number(a === 'source') - Number(b === 'source')), 'included first');
    assert.ok(filterGallery(state({ license: 'open' })).every((e) => ['MIT', 'Apache-2.0'].includes(e.license)));
    const other = filterGallery(state({ license: 'other' }));
    assert.ok(other.some((e) => e.id === 'unity-cli') && other.some((e) => e.id === 'doc-coauthoring') && other.every((e) => e.kind === 'source'));
    assert.match(galleryListHtml(state({ query: 'zzz-nothing' }), []), /No skills match/);
  });

  it('shows Enable for included skills, Install for downloads, Installed with Remove, and Name in use', () => {
    const html = galleryListHtml(state(), [skill('godot', { id: 'godot', kind: 'bundled', license: 'MIT' }), skill('docx')]);
    assert.match(row(html, 'systematic-debugging'), /Included/);
    assert.match(row(html, 'systematic-debugging'), /data-action="gallery-install" data-id="systematic-debugging"[^>]*>.*Enable/);
    assert.match(row(html, 'systematic-debugging'), /data-action="gallery-preview" data-id="systematic-debugging"/);
    assert.match(row(html, 'semgrep'), /From GitHub/);
    assert.match(row(html, 'semgrep'), /Install/);
    assert.match(row(html, 'semgrep'), /Licence terms/);
    assert.doesNotMatch(row(html, 'semgrep'), /gallery-preview/, 'downloads have no preview (that would need the network)');
    assert.match(row(html, 'godot'), /Installed/);
    assert.match(row(html, 'godot'), /data-action="gallery-remove" data-name="godot"/);
    assert.match(row(html, 'godot'), /Written for Orka/);
    assert.match(row(html, 'docx'), /Name in use/);
    assert.doesNotMatch(row(html, 'docx'), /gallery-install/);
    assert.deepEqual([...installedEntries([skill('a', { id: 'x', kind: 'source', license: 'MIT' }), skill('b')]).installed], [['x', 'a']]);
  });

  it('opens details with needs, notes and the licence terms, and escapes the search box and the preview', () => {
    const html = galleryListHtml(state({ open: new Set(['unity-cli', 'docx']) }), []);
    assert.match(row(html, 'unity-cli'), /Unity Companion License: use it only together with the Unity Engine/);
    assert.match(row(html, 'unity-cli'), /Unity Hub and the Unity CLI/);
    assert.match(row(html, 'docx'), /LibreOffice/);
    assert.match(row(html, 'docx'), /Orka never runs its scripts/);
    assert.match(row(html, 'docx'), /data-action="gallery-source" data-id="docx"/);
    const head = galleryHtml(state({ query: '"><img src=x onerror=alert(1)>' }), []);
    assert.doesNotMatch(head, /<img/);
    assert.match(head, /value="&quot;&gt;&lt;img/);
    const preview = galleryPreviewHtml(galleryEntry('godot')!, '# Godot\n<script>alert(1)</script>');
    assert.ok(!preview.toLowerCase().includes("<script"), preview);
    assert.match(preview, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(galleryPreviewHtml(galleryEntry('godot')!, undefined), /Loading/);
    assert.equal(originLabel({ id: 'semgrep', kind: 'source', license: 'CC-BY-SA-4.0', repo: 'trailofbits/skills', ref: 'e4dd0bb' }), 'trailofbits/skills@e4dd0bb · CC-BY-SA-4.0');
  });
});

let home: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-gallery-test-'));
  mkdirSync(path.join(home, 'work'), { recursive: true });
  // Two of Orka's bundled gallery skills, where the app looks for them (next to the built-in skills).
  for (const id of ['godot', 'systematic-debugging']) cpSync(path.join(GALLERY, id), path.join(home, 'builtin-skills', 'gallery', id), { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

async function start(download?: (url: string, max: number) => Promise<Uint8Array>) {
  const shell = new FakeShell('desktop', home, [path.join(home, 'work')]);
  const controller = new AppController(shell, download ? { galleryDownload: download } : {});
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

const skillsDir = () => path.join(home, 'skills');

describe('adding skills from the gallery', () => {
  it('copies an included skill into <Orka home>/skills with its licence, shows its origin and removes it after asking', async () => {
    const { shell, controller } = await start();
    assert.equal(controller.skillsDir, skillsDir());
    await controller.handleMessage({ type: 'installGallerySkill', id: 'systematic-debugging' });
    const dir = path.join(skillsDir(), 'systematic-debugging');
    for (const file of ['SKILL.md', 'LICENSE', 'NOTICE', '.orka-gallery.json']) assert.ok(existsSync(path.join(dir, file)), file);
    assert.match(shell.asked.at(-1)!.text, /Systematic debugging was added to your skills/);
    const view = shell.pageConfig()!.skills.find((s) => s.name === 'systematic-debugging')!;
    assert.deepEqual(view.origin, { id: 'systematic-debugging', kind: 'bundled', license: 'MIT' });
    assert.equal(view.source, 'user');
    // Installed already: not copied again.
    await controller.handleMessage({ type: 'installGallerySkill', id: 'systematic-debugging' });
    assert.match(shell.asked.at(-1)!.text, /already has a skill named systematic-debugging/);

    // Remove asks, and keeps the folder when declined.
    await controller.handleMessage({ type: 'removeGallerySkill', name: 'systematic-debugging' });
    assert.equal(shell.asked.at(-1)!.modal, true);
    assert.match(shell.asked.at(-1)!.detail!, /cannot be undone/);
    assert.ok(existsSync(dir));
    shell.answer = 'Remove';
    await controller.handleMessage({ type: 'removeGallerySkill', name: 'systematic-debugging' });
    assert.ok(!existsSync(dir));
    assert.equal(shell.pageConfig()!.skills.some((s) => s.name === 'systematic-debugging'), false);
  });

  it("never removes a skill of the user's own, and sends the preview text of an included skill only", async () => {
    mkdirSync(path.join(skillsDir(), 'mine'), { recursive: true });
    writeFileSync(path.join(skillsDir(), 'mine', 'SKILL.md'), '---\ndescription: My own skill for tests.\n---\nBody');
    const { shell, controller } = await start();
    shell.answer = 'Remove';
    await controller.handleMessage({ type: 'removeGallerySkill', name: 'mine' });
    assert.ok(existsSync(path.join(skillsDir(), 'mine', 'SKILL.md')));
    assert.ok(shell.asked.every((m) => !/Remove the skill/.test(m.text)));
    await controller.handleMessage({ type: 'previewGallerySkill', id: 'godot' });
    assert.equal(shell.last('skillPreview')?.id, 'godot');
    assert.equal(shell.last('skillPreview')?.text, readFileSync(path.join(GALLERY, 'godot', 'SKILL.md'), 'utf8'));
    const before = shell.posted.length;
    await controller.handleMessage({ type: 'previewGallerySkill', id: 'docx' });
    await controller.handleMessage({ type: 'previewGallerySkill', id: 'nope' });
    assert.equal(shell.posted.filter((m, i) => i >= before && m.type === 'skillPreview').length, 0);
  });

  it('downloads nothing until the user agrees in a dialog that lists every URL and the licence terms', async () => {
    const urls: string[] = [];
    const { shell, controller } = await start(async (url) => {
      urls.push(url);
      return new Uint8Array([1, 2, 3]);
    });
    await controller.handleMessage({ type: 'installGallerySkill', id: 'ui-ugui' });
    const consent = shell.asked.at(-1)!;
    assert.equal(consent.modal, true);
    assert.deepEqual(consent.actions, ['Download and install']);
    assert.match(consent.text, /Install the skill Unity uGUI\?/);
    const base = 'https://raw.githubusercontent.com/Unity-Technologies/skills/60f95e6d4beaeacf4dfdff7829ec9b35008a0be0/';
    assert.ok(consent.detail!.includes(`${base}skills/ui-ugui/SKILL.md`), consent.detail);
    assert.ok(consent.detail!.includes(`${base}LICENSE.md`), consent.detail);
    assert.match(consent.detail!, /Unity Companion License: use it only together/);
    assert.match(consent.detail!, /Orka never runs its scripts/);
    assert.deepEqual(urls, [], 'declined: nothing fetched');
    assert.ok(!existsSync(path.join(skillsDir(), 'ui-ugui')));

    // Agreed, but the file is not what the list expects: refused, nothing left behind.
    shell.answer = 'Download and install';
    await controller.handleMessage({ type: 'installGallerySkill', id: 'ui-ugui' });
    assert.equal(urls.length, 1);
    assert.match(shell.asked.at(-1)!.text, /could not be installed or removed: .*different size/);
    assert.ok(!existsSync(path.join(skillsDir(), 'ui-ugui')));
  });

  it('opens only the gallery’s own pages, and ignores unknown entries', async () => {
    const { shell, controller } = await start();
    await controller.handleMessage({ type: 'openGallerySkillSource', id: 'semgrep' });
    await controller.handleMessage({ type: 'openGallerySkillSource', id: 'nope' });
    await controller.handleMessage({ type: 'installGallerySkill', id: 'nope' });
    assert.deepEqual(shell.opened, ['https://github.com/trailofbits/skills/tree/main/plugins/static-analysis/skills/semgrep']);
    assert.equal(shell.asked.length, 0);
  });
});
