import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RunGate, SharedAccounts } from '../src/runGate';

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

  it('runs one profile of a CLI at a time, and any number of runs on the same profile', () => {
    const gate = new RunGate(() => 5);
    const work = gate.acquire('a', dir('a'), ['claude-code:work']);
    assert.ok(work.ok);
    assert.equal(gate.profileInUse('claude-code'), 'work');
    assert.equal(gate.profileInUse('codex'), undefined);
    const other = gate.acquire('b', dir('b'), ['claude-code:']);
    assert.deepEqual(other.ok ? undefined : [other.reason, (other as { account?: string }).account], ['account', 'claude-code:work']);
    assert.ok(gate.acquire('c', dir('c'), ['claude-code:work']).ok, 'the same profile runs side by side');
    assert.ok(gate.acquire('d', dir('d'), ['codex']).ok, 'another CLI is not held up');
    assert.ok(gate.acquire('e', dir('e')).ok, 'a run on no CLI account is not held up');
    gate.releaseAll('a');
    gate.releaseAll('c');
    assert.ok(gate.acquire('b', dir('b'), ['claude-code:']).ok, 'free once the other profile ends');
    assert.equal(gate.profileInUse('claude-code'), '');
  });

  it('holds accounts without a folder or a place in the budget (Radar), under the same one-profile rule', () => {
    const gate = new RunGate(() => 1);
    const radar = gate.holdAccounts('radar', ['claude-code:']);
    assert.ok(radar.ok);
    assert.equal(gate.running, 0);
    assert.equal(gate.profileInUse('claude-code'), '');
    assert.deepEqual(gate.acquire('a', dir('a'), ['claude-code:work']), { ok: false, reason: 'account', account: 'claude-code:' });
    assert.ok(gate.acquire('b', dir('b'), ['claude-code:']).ok, 'the same profile, in any folder');
    gate.releaseAll('b');
    radar.release();
    const work = gate.acquire('a', dir('a'), ['claude-code:work']);
    assert.ok(work.ok);
    assert.deepEqual(gate.holdAccounts('radar', ['claude-code:']), { ok: false, reason: 'account', account: 'claude-code:work' });
  });

  it('runs one profile of a CLI at a time across windows: each process writes the account it runs in a shared folder', () => {
    const shared = path.join(home, 'accounts');
    // Another window: a live process (this test's parent) with a gate of its own.
    const other = new RunGate(() => 5, new SharedAccounts(shared, process.ppid));
    const gate = new RunGate(() => 5, new SharedAccounts(shared));
    const work = other.acquire('x', dir('x'), ['claude-code:work']);
    assert.ok(work.ok);
    assert.deepEqual(readdirSync(shared), [`claude-code.${process.ppid}.json`]);
    assert.equal(gate.profileInUse('claude-code'), 'work');
    assert.deepEqual(gate.acquire('a', dir('a'), ['claude-code:']), { ok: false, reason: 'account', account: 'claude-code:work' });
    assert.ok(gate.acquire('b', dir('b'), ['claude-code:work']).ok, 'the same profile runs in both');
    gate.releaseAll('b');
    work.release();
    assert.deepEqual(readdirSync(shared), [], 'gone once the window runs nothing on it');
    assert.ok(gate.acquire('a', dir('a'), ['claude-code:']).ok);
    assert.deepEqual(readdirSync(shared), [`claude-code.${process.pid}.json`]);
    gate.releaseAll('a');
    // A file whose process is gone is left over: it holds nothing, and goes.
    writeFileSync(path.join(shared, 'claude-code.99999999.json'), JSON.stringify({ account: 'claude-code:work' }));
    assert.ok(gate.acquire('a', dir('a'), ['claude-code:']).ok);
    assert.deepEqual(readdirSync(shared), [`claude-code.${process.pid}.json`]);
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
