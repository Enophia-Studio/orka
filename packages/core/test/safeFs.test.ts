import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { insideWorkspace, readInsideWorkspace, replaceInsideWorkspace } from '../src/tools/safeFs';
import { tempWorkspace } from './helpers';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('safe workspace file reads and writes', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let outside: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    outside = tempWorkspace();
    fs.writeFileSync(path.join(outside.root, 'secret.txt'), 'outside\n');
  });
  afterEach(() => {
    ws.cleanup();
    outside.cleanup();
  });

  /** A folder link (a junction on Windows, which needs no admin rights). */
  const dirLink = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  /** A file link, or false when this system does not allow one (Windows without developer mode). */
  const fileLink = (target: string, at: string): boolean => {
    try {
      fs.symlinkSync(target, at, 'file');
      return true;
    } catch {
      return false;
    }
  };

  it('refuses a path that leaves the workspace by ..', () => {
    const abs = path.join(ws.root, '..', path.basename(outside.root), 'secret.txt');
    assert.equal(insideWorkspace(ws.root, abs), undefined);
    assert.deepEqual(readInsideWorkspace(ws.root, abs, 1000), { error: 'outside' });
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha('outside\n'), 'x'), { ok: false, reason: 'outside' });
    assert.equal(fs.readFileSync(path.join(outside.root, 'secret.txt'), 'utf8'), 'outside\n');
  });

  it('refuses a junction out of the workspace, for reading and for replacing', () => {
    dirLink(outside.root, path.join(ws.root, 'out'));
    const abs = path.join(ws.root, 'out', 'secret.txt');
    assert.equal(insideWorkspace(ws.root, abs), undefined);
    assert.deepEqual(readInsideWorkspace(ws.root, abs, 1000), { error: 'outside' });
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha('outside\n'), 'x'), { ok: false, reason: 'outside' });
    assert.equal(fs.readFileSync(path.join(outside.root, 'secret.txt'), 'utf8'), 'outside\n');
  });

  it('refuses a file link out of the workspace', (t) => {
    if (!fileLink(path.join(outside.root, 'secret.txt'), path.join(ws.root, 'notes.txt'))) return t.skip('file links cannot be made here');
    const abs = path.join(ws.root, 'notes.txt');
    assert.deepEqual(readInsideWorkspace(ws.root, abs, 1000), { error: 'outside' });
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha('outside\n'), 'x'), { ok: false, reason: 'outside' });
    assert.equal(fs.readFileSync(path.join(outside.root, 'secret.txt'), 'utf8'), 'outside\n');
  });

  it('follows a link inside the workspace to a target inside it', () => {
    fs.mkdirSync(path.join(ws.root, 'real'));
    fs.writeFileSync(path.join(ws.root, 'real', 'a.txt'), 'inside\n');
    dirLink(path.join(ws.root, 'real'), path.join(ws.root, 'alias'));
    const abs = path.join(ws.root, 'alias', 'a.txt');
    assert.equal(insideWorkspace(ws.root, abs), path.join(fs.realpathSync.native(ws.root), 'real', 'a.txt'));
    const read = readInsideWorkspace(ws.root, abs, 1000);
    assert.ok('bytes' in read);
    assert.equal(read.bytes.toString('utf8'), 'inside\n');
    const replaced = replaceInsideWorkspace(ws.root, abs, sha('inside\n'), 'changed\n');
    assert.ok(replaced.ok);
    assert.equal(fs.readFileSync(path.join(ws.root, 'real', 'a.txt'), 'utf8'), 'changed\n');
  });

  it('reports a missing path and a folder', () => {
    fs.mkdirSync(path.join(ws.root, 'dir'));
    assert.deepEqual(readInsideWorkspace(ws.root, path.join(ws.root, 'missing.txt'), 1000), { error: 'notFound' });
    assert.deepEqual(readInsideWorkspace(ws.root, path.join(ws.root, 'dir'), 1000), { error: 'notFile' });
  });

  it('refuses a file over the limit, also one that grows past it while it is read', (t) => {
    const abs = path.join(ws.root, 'big.txt');
    fs.writeFileSync(abs, 'x'.repeat(100));
    assert.ok('bytes' in readInsideWorkspace(ws.root, abs, 100));
    assert.deepEqual(readInsideWorkspace(ws.root, abs, 99), { error: 'tooLarge' });
    // The size the open handle reports is small; the file has grown by the time it is read.
    const fstatSync = fs.fstatSync;
    t.mock.method(fs, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
      const stats = fstatSync(fd, options as { bigint: true });
      stats.size = 10n;
      return stats;
    });
    assert.deepEqual(readInsideWorkspace(ws.root, abs, 50), { error: 'tooLarge' });
  });

  it('refuses to replace a file whose bytes changed, and leaves the disk as it is', () => {
    const abs = path.join(ws.root, 'a.txt');
    fs.writeFileSync(abs, 'theirs\n');
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha('mine\n'), 'new\n'), { ok: false, reason: 'conflict', hash: sha('theirs\n') });
    assert.equal(fs.readFileSync(abs, 'utf8'), 'theirs\n');
  });

  it('never creates a file: a deleted one is gone', () => {
    const abs = path.join(ws.root, 'gone.txt');
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha(''), 'new\n'), { ok: false, reason: 'gone' });
    assert.equal(fs.existsSync(abs), false);
  });

  it('refuses a folder swapped for a link out of the workspace after the check', (t) => {
    fs.mkdirSync(path.join(ws.root, 'docs'));
    const abs = path.join(ws.root, 'docs', 'secret.txt');
    fs.writeFileSync(abs, 'outside\n');
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: number, mode?: number) => {
      // Between the path checks and the open, another program swaps the folder for a junction.
      if (!fs.existsSync(path.join(ws.root, 'docs-real'))) {
        fs.renameSync(path.join(ws.root, 'docs'), path.join(ws.root, 'docs-real'));
        dirLink(outside.root, path.join(ws.root, 'docs'));
      }
      return openSync(file, flags, mode);
    });
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha('outside\n'), 'payload\n'), { ok: false, reason: 'outside' });
    assert.equal(fs.readFileSync(path.join(outside.root, 'secret.txt'), 'utf8'), 'outside\n');
    assert.deepEqual(readInsideWorkspace(ws.root, path.join(ws.root, 'docs', 'secret.txt'), 1000), { error: 'outside' });
  });

  it('does not wait on a FIFO', (t) => {
    if (process.platform === 'win32') return t.skip('no FIFOs on Windows');
    const abs = path.join(ws.root, 'pipe');
    execFileSync('mkfifo', [abs]);
    assert.deepEqual(readInsideWorkspace(ws.root, abs, 1000), { error: 'notFile' });
    assert.deepEqual(replaceInsideWorkspace(ws.root, abs, sha(''), 'x'), { ok: false, reason: 'gone' });
  });

  it('writes exactly the given bytes, in place, and returns the bytes it replaced', () => {
    const abs = path.join(ws.root, 'a.txt');
    const before = Buffer.from('﻿old line\r\nsecond line that is longer\r\n', 'utf8');
    fs.writeFileSync(abs, before);
    const ino = fs.statSync(abs, { bigint: true }).ino;
    const content = '﻿new\r\nçok güzel\r\n';
    const result = replaceInsideWorkspace(ws.root, abs, sha(before), content);
    assert.ok(result.ok);
    assert.deepEqual(result.before, before);
    assert.deepEqual(fs.readFileSync(abs), Buffer.from(content, 'utf8'));
    assert.equal(fs.statSync(abs, { bigint: true }).ino, ino, 'the same file, not a new one');
    const read = readInsideWorkspace(ws.root, abs, 1000);
    assert.ok('bytes' in read);
    assert.deepEqual(read.bytes, Buffer.from(content, 'utf8'));
  });
});
