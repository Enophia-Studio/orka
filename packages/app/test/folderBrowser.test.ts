import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import { checkFolderPath, folderNameProblem, folderSegments, MAX_FOLDER_ENTRIES, NodeFolderBrowser } from '../src/folderBrowser';
import type { FolderBrowser } from '../src/shell';
import { FakeShell } from './fakeShell';

let home: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-folders-'));
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

/** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
function linkFolder(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('folder picker: paths and names', () => {
  it('takes only absolute paths without NUL, normalised', () => {
    assert.equal(checkFolderPath('relative/dir'), undefined);
    assert.equal(checkFolderPath(''), undefined);
    assert.equal(checkFolderPath(42), undefined);
    assert.equal(checkFolderPath(undefined), undefined);
    assert.equal(checkFolderPath(`${home}\0x`), undefined);
    assert.equal(checkFolderPath(path.join(home, 'a', '..', 'b')), path.join(home, 'b'));
    assert.equal(checkFolderPath(`${home}${path.sep}`), path.resolve(home));
    if (process.platform === 'win32') {
      assert.equal(checkFolderPath('\\\\?\\C:\\Windows'), undefined);
      assert.equal(checkFolderPath('\\\\.\\PhysicalDrive0'), undefined);
      assert.equal(checkFolderPath('C:'), undefined, 'a drive-relative path');
    }
  });

  it('refuses names that are empty, have separators, are reserved or end in a dot or space', () => {
    assert.equal(folderNameProblem('Game'), undefined);
    assert.equal(folderNameProblem('my game (2)'), undefined);
    assert.equal(folderNameProblem(''), 'empty');
    assert.equal(folderNameProblem('   '), 'empty');
    assert.equal(folderNameProblem(7), 'empty');
    assert.equal(folderNameProblem('a/b'), 'separator');
    assert.equal(folderNameProblem('a\\b'), 'separator');
    assert.equal(folderNameProblem('..'), 'reserved');
    assert.equal(folderNameProblem('CON'), 'reserved');
    assert.equal(folderNameProblem('lpt1.txt'), 'reserved');
    assert.equal(folderNameProblem('name.'), 'trailing');
    assert.equal(folderNameProblem('name '), 'trailing');
    assert.equal(folderNameProblem('a:b'), 'invalidChars');
    assert.equal(folderNameProblem('a?'), 'invalidChars');
    assert.equal(folderNameProblem('tab\there'), 'invalidChars');
    assert.equal(folderNameProblem('x'.repeat(256)), 'tooLong');
  });

  it('builds the breadcrumb from the root down', () => {
    const dir = path.join(home, 'a', 'b');
    const segments = folderSegments(dir);
    assert.equal(segments[0].path, path.parse(dir).root);
    assert.deepEqual(segments.slice(-2), [
      { name: 'a', path: path.join(home, 'a') },
      { name: 'b', path: dir },
    ]);
  });
});

describe('folder picker: listing', () => {
  it('lists subfolders only, sorted without regard to case, with links marked', async () => {
    for (const name of ['beta', 'Alpha', 'gamma', '.hidden']) mkdirSync(path.join(home, name));
    writeFileSync(path.join(home, 'notes.txt'), 'secret contents');
    linkFolder(path.join(home, 'gamma'), path.join(home, 'Link'));
    const listing = await new NodeFolderBrowser(home).list(home, { hidden: false });
    assert.equal(listing.error, undefined);
    assert.equal(listing.path, home);
    assert.equal(listing.parent, path.dirname(home));
    assert.deepEqual(
      listing.entries.map((e) => e.name),
      ['Alpha', 'beta', 'gamma', 'Link'],
    );
    assert.deepEqual(listing.entries.find((e) => e.name === 'Link'), { name: 'Link', path: path.join(home, 'Link'), link: true });
    assert.equal(listing.entries[0].path, path.join(home, 'Alpha'));
    assert.ok(!JSON.stringify(listing).includes('notes.txt') && !JSON.stringify(listing).includes('secret'), 'no file names or contents');
    assert.equal(listing.truncated, false);
  });

  it('shows hidden folders only when asked', async () => {
    mkdirSync(path.join(home, '.config'));
    mkdirSync(path.join(home, 'visible'));
    if (process.platform === 'win32') mkdirSync(path.join(home, 'AppData'));
    const browser = new NodeFolderBrowser(home);
    assert.deepEqual(
      (await browser.list(home, { hidden: false })).entries.map((e) => e.name),
      ['visible'],
    );
    const all = (await browser.list(home, { hidden: true })).entries.map((e) => e.name);
    assert.deepEqual(all, process.platform === 'win32' ? ['.config', 'AppData', 'visible'] : ['.config', 'visible']);
  });

  it('leaves out a link whose target is gone', async () => {
    mkdirSync(path.join(home, 'target'));
    linkFolder(path.join(home, 'target'), path.join(home, 'broken'));
    rmSync(path.join(home, 'target'), { recursive: true });
    assert.deepEqual((await new NodeFolderBrowser(home).list(home, { hidden: false })).entries, []);
  });

  it(`shows the first ${MAX_FOLDER_ENTRIES} folders and says so`, async () => {
    for (let i = 0; i <= MAX_FOLDER_ENTRIES; i++) mkdirSync(path.join(home, `d${String(i).padStart(5, '0')}`));
    const listing = await new NodeFolderBrowser(home).list(home, { hidden: false });
    assert.equal(listing.entries.length, MAX_FOLDER_ENTRIES);
    assert.equal(listing.truncated, true);
    assert.equal(listing.entries[0].name, 'd00000');
  });

  it('reports a missing folder or a file as not found, never throws', async () => {
    writeFileSync(path.join(home, 'file.txt'), 'x');
    const browser = new NodeFolderBrowser(home);
    const missing = await browser.list(path.join(home, 'nope'), { hidden: false });
    assert.equal(missing.error, 'notFound');
    assert.equal(missing.parent, home, 'the user can go back');
    assert.deepEqual(missing.entries, []);
    assert.equal((await browser.list(path.join(home, 'file.txt'), { hidden: false })).error, 'notFound');
  });

  it('reports a folder the system refuses to read', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions and a non-root user' }, async () => {
    const locked = path.join(home, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const listing = await new NodeFolderBrowser(home).list(locked, { hidden: false });
      assert.equal(listing.error, 'denied');
      assert.equal(listing.parent, home);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('offers recent folders first, then the home folders that exist, then the drives', async () => {
    mkdirSync(path.join(home, 'Desktop'));
    mkdirSync(path.join(home, 'Documents'));
    const recent = path.join(home, 'Documents');
    const places = await new NodeFolderBrowser(home).places([recent]);
    assert.deepEqual(places[0], { kind: 'recent', name: 'Documents', path: recent });
    assert.deepEqual(
      places.filter((p) => ['home', 'desktop', 'documents', 'downloads'].includes(p.kind)).map((p) => p.kind),
      ['home', 'desktop', 'documents'],
      'Downloads does not exist',
    );
    const root = path.parse(home).root;
    if (process.platform === 'win32') assert.ok(places.some((p) => p.kind === 'drive' && p.path.toLowerCase() === root.toLowerCase()), 'the drive of the temp folder');
    else assert.ok(places.some((p) => p.kind === 'root' && p.path === '/'));
  });
});

describe('folder picker: new folder', () => {
  it('creates one folder in the folder shown', async () => {
    const created = await new NodeFolderBrowser(home).create(home, 'Game');
    assert.deepEqual(created, { path: path.join(home, 'Game') });
    assert.ok(existsSync(path.join(home, 'Game')));
  });

  it('refuses a bad name, an existing name and a missing parent (never creates parents)', async () => {
    const browser = new NodeFolderBrowser(home);
    mkdirSync(path.join(home, 'Game'));
    writeFileSync(path.join(home, 'file'), 'x');
    assert.deepEqual(await browser.create(home, 'Game'), { error: 'exists' });
    assert.deepEqual(await browser.create(home, 'file'), { error: 'exists' });
    assert.deepEqual(await browser.create(home, 'a/b'), { error: 'separator' });
    assert.deepEqual(await browser.create(home, 'NUL'), { error: 'reserved' });
    assert.deepEqual(await browser.create(home, 'x.'), { error: 'trailing' });
    assert.deepEqual(await browser.create(home, ''), { error: 'empty' });
    assert.deepEqual(await browser.create(path.join(home, 'missing'), 'New'), { error: 'notFound' });
    assert.equal(existsSync(path.join(home, 'missing')), false);
  });
});

describe('folder picker: messages', () => {
  async function start(kind: 'vscode' | 'desktop', browser?: FolderBrowser) {
    const work = path.join(home, 'work');
    const other = path.join(home, 'other');
    mkdirSync(path.join(work, 'src'), { recursive: true });
    mkdirSync(other, { recursive: true });
    mkdirSync(path.join(home, 'builtin-skills'), { recursive: true });
    const shell = new FakeShell(kind, home, [work, other]);
    shell.folderBrowser = browser;
    const controller = new AppController(shell);
    controllers.push(controller);
    await controller.initialize();
    return { shell, controller, work, other };
  }

  it('lists where the picker starts (the open folder), with the places, and says the app has a picker', async () => {
    const { shell, controller, work, other } = await start('desktop', new NodeFolderBrowser(home));
    await controller.handleMessage({ type: 'ready' });
    assert.equal(shell.last('init')?.config.canBrowseFolders, true);
    await controller.handleMessage({ type: 'listFolders', id: 3, places: true });
    const listing = shell.last('folderListing');
    assert.equal(listing?.id, 3);
    assert.equal(listing?.path, work);
    assert.deepEqual(
      listing?.entries.map((e) => e.name),
      ['src'],
    );
    assert.deepEqual(
      listing?.places?.filter((p) => p.kind === 'recent').map((p) => p.path),
      [work, other],
    );
    await controller.handleMessage({ type: 'listFolders', id: 4, path: home, hidden: true });
    assert.equal(shell.last('folderListing')?.places, undefined, 'places only when asked');
    assert.deepEqual(
      shell.last('folderListing')?.entries.map((e) => e.name),
      ['builtin-skills', 'other', 'work'],
    );
  });

  it('answers a path that is not absolute with an error, and passes unreadable folders on', async () => {
    const denied: FolderBrowser = {
      home,
      list: async (dir) => ({ path: dir, parent: path.dirname(dir), segments: [], entries: [], truncated: false, error: 'denied' }),
      places: async () => [],
      create: async () => ({ error: 'denied' }),
    };
    const { shell, controller, work } = await start('desktop', denied);
    await controller.handleMessage({ type: 'listFolders', id: 1, path: 'relative' });
    assert.deepEqual(shell.last('folderListing'), { type: 'folderListing', id: 1, path: '', segments: [], entries: [], truncated: false, error: 'invalid' });
    await controller.handleMessage({ type: 'listFolders', id: 2, path: work });
    assert.equal(shell.last('folderListing')?.error, 'denied');
    assert.equal(shell.last('folderListing')?.parent, home);
    await controller.handleMessage({ type: 'createFolder', id: 3, parent: work, name: 'New' });
    assert.deepEqual(shell.last('folderCreated'), { type: 'folderCreated', id: 3, error: 'denied' });
    // A malformed id gets no answer.
    const before = shell.posted.length;
    await controller.handleMessage({ type: 'listFolders', id: 'x' as unknown as number });
    assert.equal(shell.posted.length, before);
  });

  it('creates a folder and names it, refusing a parent that is not absolute', async () => {
    const { shell, controller, work } = await start('desktop', new NodeFolderBrowser(home));
    await controller.handleMessage({ type: 'createFolder', id: 5, parent: work, name: 'Level 2' });
    assert.deepEqual(shell.last('folderCreated'), { type: 'folderCreated', id: 5, path: path.join(work, 'Level 2'), name: 'Level 2' });
    assert.ok(existsSync(path.join(work, 'Level 2')));
    await controller.handleMessage({ type: 'createFolder', id: 6, parent: 'work', name: 'X' });
    assert.deepEqual(shell.last('folderCreated'), { type: 'folderCreated', id: 6, error: 'invalid' });
    await controller.handleMessage({ type: 'createFolder', id: 7, parent: work, name: 'Level 2' });
    assert.equal(shell.last('folderCreated')?.error, 'exists');
  });

  it('opens a folder chosen in the picker by its absolute path only', async () => {
    const { shell, controller, other } = await start('desktop', new NodeFolderBrowser(home));
    await controller.handleMessage({ type: 'openFolder', path: 'other' });
    assert.notEqual(shell.currentFolder()?.path, other);
    await controller.handleMessage({ type: 'openFolder', path: path.join(other, '.') });
    assert.equal(shell.currentFolder()?.path, other);
  });

  for (const kind of ['vscode', 'desktop'] as const) {
    it(`leaves a shell without a picker as it was (${kind === 'vscode' ? 'VS Code' : 'the fake desktop shell'})`, async () => {
      const { shell, controller, work } = await start(kind);
      await controller.handleMessage({ type: 'ready' });
      assert.equal(shell.last('init')?.config.canBrowseFolders, undefined);
      await controller.handleMessage({ type: 'listFolders', id: 1, path: work });
      await controller.handleMessage({ type: 'createFolder', id: 2, parent: work, name: 'New' });
      assert.equal(shell.last('folderListing'), undefined);
      assert.equal(shell.last('folderCreated'), undefined);
      assert.equal(existsSync(path.join(work, 'New')), false);
    });
  }
});
