import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RunGate } from '../src/runGate';

let home: string;
const dir = (...parts: string[]) => {
  const p = path.join(home, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-gate-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('RunGate', () => {
  it('lets as many sessions run as the budget allows, reading it on every start', () => {
    let max = 2;
    const gate = new RunGate(() => max);
    const a = gate.acquire('a', dir('a'));
    const b = gate.acquire('b', dir('b'));
    assert.ok(a.ok && b.ok);
    assert.equal(gate.running, 2);
    assert.deepEqual(gate.acquire('c', dir('c')), { ok: false, reason: 'budget', running: 2, max: 2 });
    max = 3;
    const c = gate.acquire('c', dir('c'));
    assert.ok(c.ok);
    // Released (twice is harmless): room again.
    max = 2;
    a.release();
    a.release();
    assert.equal(gate.running, 2);
    assert.deepEqual(gate.acquire('d', dir('d')), { ok: false, reason: 'budget', running: 2, max: 2 });
    b.release();
    assert.ok(gate.acquire('d', dir('d')).ok);
  });

  it('runs one session at a time in a folder, under any of its names', () => {
    const gate = new RunGate(() => 8);
    const app = dir('app');
    assert.ok(gate.acquire('a', app).ok);
    assert.deepEqual(gate.acquire('b', path.join(app, '.')), { ok: false, reason: 'folder', holder: app });
    if (process.platform === 'win32') assert.equal(gate.acquire('b', app.toUpperCase()).ok, false, 'Windows paths ignore case');
    const link = path.join(home, 'link');
    symlinkSync(app, link, 'junction');
    assert.equal(gate.acquire('b', link).ok, false, 'a link to the folder is the folder');
    assert.equal(gate.busyNear(link, 'b'), app);
  });

  it('keeps nested folders apart both ways, but not siblings that share a prefix', () => {
    const gate = new RunGate(() => 8);
    const app = dir('app');
    const inner = dir('app', 'packages', 'web');
    const sibling = dir('app2');
    const outer = gate.acquire('outer', app);
    assert.ok(outer.ok);
    assert.equal(gate.acquire('inner', inner).ok, false, 'a folder inside one that runs');
    assert.ok(gate.acquire('sibling', sibling).ok, '"app2" is not inside "app"');
    outer.release();
    assert.ok(gate.acquire('inner', inner).ok);
    assert.deepEqual(gate.acquire('outer', app), { ok: false, reason: 'folder', holder: inner }, 'a folder around one that runs');
  });

  it('lets a hand-off hold its folder without counting toward the budget', () => {
    const gate = new RunGate(() => 1);
    const app = dir('app');
    const release = gate.holdFolder('a', app);
    assert.equal(gate.running, 0);
    assert.equal(gate.acquire('b', dir('app', 'src')).ok, false, 'no other session runs in the folder');
    assert.equal(gate.busyNear(app, 'b'), app);
    assert.equal(gate.busyNear(app, 'a'), undefined, 'the session itself is not kept out');
    const own = gate.acquire('a', app);
    assert.ok(own.ok, 'the session that handed off runs there');
    assert.ok(gate.acquire('c', dir('other')).ok === false, 'its run counts toward the budget');
    own.release();
    release();
    assert.ok(gate.acquire('b', app).ok);
  });

  it("lets go of everything of a session that goes away", () => {
    const gate = new RunGate(() => 1);
    const app = dir('app');
    const run = gate.acquire('a', app);
    assert.ok(run.ok);
    gate.holdFolder('a', app);
    gate.releaseAll('a');
    assert.equal(gate.running, 0);
    assert.equal(gate.busyNear(app), undefined);
    const next = gate.acquire('b', app);
    assert.ok(next.ok);
    // The old run's own release later frees nothing else.
    run.release();
    assert.equal(gate.running, 1);
  });
});
