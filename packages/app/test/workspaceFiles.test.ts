import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MAX_DIR_ENTRIES, MAX_EDITOR_BYTES, WorkspaceFiles } from '../src/workspaceFiles';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

let root: string;
let outside: string;
let files: WorkspaceFiles;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'orka-files-'));
  outside = fs.mkdtempSync(path.join(tmpdir(), 'orka-files-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
  files = new WorkspaceFiles(root);
});

afterEach(() => {
  // Windows: a virus scanner or the search indexer can hold the folder for a moment.
  for (const dir of [root, outside]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A folder link (a junction on Windows, which needs no admin rights). */
const dirLink = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const write = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

describe('workspace paths from the page', () => {
  it('resolves a plain relative path to the path in the folder and where it leads', () => {
    write('src/a.ts', 'x');
    const resolved = files.resolve('src/a.ts');
    assert.equal(resolved?.abs, path.join(root, 'src', 'a.ts'));
    assert.equal(resolved?.real, path.join(fs.realpathSync.native(root), 'src', 'a.ts'));
  });

  it('refuses paths that are malformed, absolute, in .git or lead out of the folder', () => {
    write('.git/config', '[core]\n');
    dirLink(outside, path.join(root, 'out'));
    for (const rel of ['', '../x', '/x', 'C:x', 'a:b', 'a\\b', 'a//b', 'a/', './a', 'a/./b', 'a/../b', 'x\0y', '.git/config', '.git', 'sub/.GIT/x', 'out/secret.txt', 'x'.repeat(1025)]) {
      assert.equal(files.resolve(rel), undefined, JSON.stringify(rel));
    }
    assert.equal(files.resolve(42 as unknown as string), undefined);
  });

  it("refuses Windows device names and names Windows would change", (t) => {
    if (process.platform !== 'win32') return t.skip('Windows-only names');
    for (const rel of ['CON', 'nul.txt', 'src/com1', 'LPT9.log', 'foo.', 'foo ', 'dir./a']) assert.equal(files.resolve(rel), undefined, rel);
    assert.ok(files.resolve('console.txt'), 'a name that only starts like a device is fine');
  });

  it('refuses a link inside the folder that leads into .git', () => {
    write('.git/config', '[core]\n');
    dirLink(path.join(root, '.git'), path.join(root, 'gitdir'));
    assert.equal(files.resolve('gitdir/config'), undefined);
    const listing = files.list('');
    assert.ok('entries' in listing);
    assert.ok(!listing.entries.some((e) => e.name === 'gitdir'));
  });
});

describe('listing folders', () => {
  it('lists folders first, by name regardless of case, hides .git and marks ignored folders', () => {
    write('b.txt', '');
    write('A.txt', '');
    write('zeta/x.txt', '');
    write('Alpha/x.txt', '');
    write('node_modules/p/index.js', '');
    write('Library/cache', '');
    write('.git/HEAD', '');
    const listing = files.list('');
    assert.ok('entries' in listing);
    assert.deepEqual(listing.entries, [
      { name: 'Alpha', kind: 'dir' },
      { name: 'Library', kind: 'dir', ignored: true },
      { name: 'node_modules', kind: 'dir', ignored: true },
      { name: 'zeta', kind: 'dir' },
      { name: 'A.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
    ]);
    assert.equal(listing.truncated, false);
    const sub = files.list('Alpha');
    assert.ok('entries' in sub);
    assert.deepEqual(sub.entries, [{ name: 'x.txt', kind: 'file' }]);
  });

  it('caps a large folder and says it was cut', () => {
    for (let i = 0; i <= MAX_DIR_ENTRIES; i++) write(`many/f${String(i).padStart(5, '0')}.txt`, '');
    const listing = files.list('many');
    assert.ok('entries' in listing);
    assert.equal(listing.entries.length, MAX_DIR_ENTRIES);
    assert.equal(listing.truncated, true);
  });

  it('lists a link that stays inside the folder and drops one that leaves it', () => {
    write('real/a.txt', 'x');
    dirLink(path.join(root, 'real'), path.join(root, 'alias'));
    dirLink(outside, path.join(root, 'out'));
    const listing = files.list('');
    assert.ok('entries' in listing);
    assert.deepEqual(
      listing.entries.map((e) => [e.name, e.kind, e.link ?? false]),
      [
        ['alias', 'dir', true],
        ['real', 'dir', false],
      ],
    );
    assert.deepEqual(files.list('out'), { error: 'outside' });
    assert.deepEqual(files.list('missing'), { error: 'notFound' });
    assert.deepEqual(files.list('../x'), { error: 'outside' });
  });
});

describe('reading files', () => {
  it('reads a file up to 2 MB and refuses one byte more', () => {
    write('max.txt', 'x'.repeat(MAX_EDITOR_BYTES));
    write('over.txt', 'x'.repeat(MAX_EDITOR_BYTES + 1));
    const read = files.read('max.txt');
    assert.ok('text' in read);
    assert.equal(read.size, MAX_EDITOR_BYTES);
    assert.deepEqual(files.read('over.txt'), { error: 'tooLarge' });
  });

  it('refuses binary files, and text that is not UTF-8', () => {
    write('data.txt', Buffer.from([0x61, 0x00, 0x62]));
    write('image.png', 'not really a png');
    write('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    write('utf16.txt', Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    assert.deepEqual(files.read('data.txt'), { error: 'binary' });
    assert.deepEqual(files.read('image.png'), { error: 'binary' });
    assert.deepEqual(files.read('latin1.txt'), { error: 'encoding' });
    assert.deepEqual(files.read('utf16.txt'), { error: 'encoding' });
    assert.deepEqual(files.read('missing.txt'), { error: 'notFound' });
    assert.deepEqual(files.read('../secret.txt'), { error: 'outside' });
  });

  it('hands the text over with \\n line breaks and no BOM, and says how the file was written', () => {
    write('crlf.txt', '﻿one\r\ntwo\r\n');
    const read = files.read('crlf.txt');
    assert.ok('text' in read);
    assert.deepEqual(read, { text: 'one\ntwo\n', hash: sha(Buffer.from('﻿one\r\ntwo\r\n', 'utf8')), size: 13, eol: 'crlf', bom: true });
    write('lf.txt', 'a\n\nb');
    assert.deepEqual(files.read('lf.txt'), { text: 'a\n\nb', hash: sha('a\n\nb'), size: 4, eol: 'lf', bom: false });
  });

  it('opens a file with mixed line endings read-only', () => {
    write('mixed.txt', 'a\r\nb\nc');
    write('cr.txt', 'a\rb');
    const mixed = files.read('mixed.txt');
    assert.ok('text' in mixed);
    assert.equal(mixed.text, 'a\nb\nc');
    assert.equal(mixed.eol, 'mixed');
    assert.equal(mixed.readOnly, true);
    const cr = files.read('cr.txt');
    assert.ok('text' in cr && cr.readOnly);
  });

  it('answers a re-check of an unchanged file without the text', () => {
    write('a.txt', 'hello\n');
    assert.deepEqual(files.read('a.txt', sha('hello\n')), { unchanged: true, hash: sha('hello\n') });
    assert.ok('text' in files.read('a.txt', sha('other')));
  });
});

describe('saving files', () => {
  const roundTrip = (rel: string, bytes: Buffer) => {
    write(rel, bytes);
    const read = files.read(rel);
    assert.ok('text' in read);
    const saved = files.save(rel, read.text, read.hash);
    assert.ok(saved.ok, JSON.stringify(saved));
    assert.deepEqual(fs.readFileSync(path.join(root, rel)), bytes);
    assert.equal(saved.hash, read.hash, 'a save that changes nothing keeps the hash');
    return read;
  };

  it('keeps CRLF, LF and a BOM byte for byte', () => {
    roundTrip('crlf.txt', Buffer.from('one\r\ntwo\r\n'));
    roundTrip('lf.txt', Buffer.from('one\ntwo'));
    const bom = Buffer.from('﻿one\r\nçok\r\n', 'utf8');
    const read = roundTrip('bom.txt', bom);
    const saved = files.save('bom.txt', `${'text' in read ? read.text : ''}three\n`, sha(bom));
    assert.ok(saved.ok);
    assert.deepEqual(fs.readFileSync(path.join(root, 'bom.txt')), Buffer.from('﻿one\r\nçok\r\nthree\r\n', 'utf8'));
    assert.equal(saved.before, '﻿one\r\nçok\r\n');
    assert.equal(saved.after, '﻿one\r\nçok\r\nthree\r\n');
    assert.equal(saved.hash, sha(fs.readFileSync(path.join(root, 'bom.txt'))));
  });

  it('refuses to overwrite a file that changed on disk, and leaves it as it is', () => {
    write('a.txt', 'mine\n');
    const base = sha('mine\n');
    write('a.txt', 'theirs\n');
    assert.deepEqual(files.save('a.txt', 'edited\n', base), { ok: false, reason: 'conflict', hash: sha('theirs\n') });
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'theirs\n');
    // The disk hash after a confirm overwrites it.
    assert.ok(files.save('a.txt', 'edited\n', sha('theirs\n')).ok);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'edited\n');
  });

  it('never creates a file, and refuses mixed line endings, bad requests and paths outside', () => {
    write('a.txt', 'x');
    fs.rmSync(path.join(root, 'a.txt'));
    assert.deepEqual(files.save('a.txt', 'x', sha('x')), { ok: false, reason: 'gone' });
    assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
    write('mixed.txt', 'a\r\nb\n');
    assert.deepEqual(files.save('mixed.txt', 'a\nb\n', sha('a\r\nb\n')), { ok: false, reason: 'readOnly' });
    assert.equal(fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'), 'a\r\nb\n');
    write('b.txt', 'b');
    assert.deepEqual(files.save('b.txt', 'b', 'not-a-hash'), { ok: false, reason: 'invalid' });
    assert.deepEqual(files.save('b.txt', 42 as unknown as string, sha('b')), { ok: false, reason: 'invalid' });
    assert.deepEqual(files.save('b.txt', 'x'.repeat(MAX_EDITOR_BYTES + 1), sha('b')), { ok: false, reason: 'tooLarge' });
    dirLink(outside, path.join(root, 'out'));
    assert.deepEqual(files.save('out/secret.txt', 'pwned', sha('outside\n')), { ok: false, reason: 'outside' });
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside\n');
  });
});
