import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

const SETTINGS: OrchestratorSettings = { maxIterations: 20, autoVerify: false, commandTimeoutMs: 30_000 };

describe('Rewind', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  const read = (name: string) => readFileSync(path.join(ws.root, name), 'utf8');
  beforeEach(() => {
    ws = tempWorkspace();
    writeFileSync(path.join(ws.root, 'a.txt'), 'a0\n');
    writeFileSync(path.join(ws.root, 'gone.txt'), 'keep me\n');
  });
  afterEach(() => ws.cleanup());

  it('goes back to just before a request: files, conversation, plan and transcript', async () => {
    const provider = new ScriptedProvider([
      // Request 1: a0 -> a1.
      () => [call('edit_file', { path: 'a.txt', old_string: 'a0', new_string: 'a1' })],
      () => [text('a is a1.')],
      // Request 2: a1 -> a2, a new file, a deleted file, a plan.
      () => [
        call('edit_file', { path: 'a.txt', old_string: 'a1', new_string: 'a2' }),
        call('write_file', { path: 'new.txt', content: 'new\n' }),
        call('delete_file', { path: 'gone.txt' }),
        call('update_plan', { steps: [{ title: 'Second step', status: 'in_progress' }] }),
      ],
      () => [text('Done with the second request.')],
      // Request 3: a2 -> a3.
      () => [call('edit_file', { path: 'a.txt', old_string: 'a2', new_string: 'a3' })],
      () => [text('a is a3.')],
      // After going back to request 2, the history ends with request 1's answer.
      (req) => {
        const texts = req.messages.map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
        assert.ok(texts.some((t) => t.includes('a is a1.')));
        assert.ok(!texts.some((t) => t.includes('second request') || t.includes('a3')), 'nothing from the later requests remains');
        assert.match(texts.at(-1)!, /try it differently/);
        return [text('Trying it differently.')];
      },
    ]);
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    const orchestrator = new Orchestrator({ host, getProvider: () => provider, permissions: new PermissionManager('autonomous'), getSettings: () => SETTINGS });
    const session = emptySession();
    orchestrator.on((e) => applyEvent(session, e));

    await orchestrator.run('make it a1');
    await orchestrator.run('make it a2 and tidy up');
    // The user keeps the second request's changes before the third one; going back still restores files.
    orchestrator.changes.acceptAll();
    await orchestrator.run('make it a3');
    assert.equal(read('a.txt'), 'a3\n');
    assert.deepEqual(orchestrator.rewindTargets.map((t) => t.text), ['make it a1', 'make it a2 and tidy up', 'make it a3']);

    const second = orchestrator.rewindTargets[1];
    const result = await orchestrator.rewind(second.id);
    assert.equal(result?.text, 'make it a2 and tidy up');
    assert.deepEqual(result?.restored, ['a.txt', 'gone.txt', 'new.txt']);
    assert.equal(read('a.txt'), 'a1\n');
    assert.equal(read('gone.txt'), 'keep me\n');
    assert.ok(!existsSync(path.join(ws.root, 'new.txt')));
    assert.equal(orchestrator.currentPlan, undefined, 'the plan made in request 2 is gone');
    assert.deepEqual(orchestrator.rewindTargets.map((t) => t.text), ['make it a1']);
    assert.deepEqual(
      session.items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : '')),
      ['make it a1'],
      'the transcript ends before the rewound message',
    );
    // The rewind is reviewable (and can be undone): request 2's changes had been kept, so taking
    // them back shows up as changes against the state just before the rewind.
    assert.deepEqual(
      (await orchestrator.changes.list()).map((c) => `${c.relPath} ${c.status}`),
      ['a.txt modified', 'gone.txt added', 'new.txt deleted'],
    );
    assert.equal(await orchestrator.rewind(second.id), undefined, 'a point is used up once gone back to');

    assert.equal(await orchestrator.run('try it differently'), 'completed');
    assert.equal(provider.remaining, 0);
  });

  it('has nothing to go back to after a new task', async () => {
    const provider = new ScriptedProvider([() => [text('Hi.')]]);
    const host = new NodeHost({ workspaceRoot: ws.root });
    const orchestrator = new Orchestrator({ host, getProvider: () => provider, permissions: new PermissionManager('balanced'), getSettings: () => SETTINGS });
    await orchestrator.run('hello');
    const [first] = orchestrator.rewindTargets;
    orchestrator.reset();
    assert.deepEqual(orchestrator.rewindTargets, []);
    assert.equal(await orchestrator.rewind(first.id), undefined);
  });
});

describe('Rewind keeps files the user edited by hand', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let host: NodeHost;
  let changes: ChangeTracker;
  const file = () => path.join(ws.root, 'a.txt');
  const read = () => readFileSync(file(), 'utf8');
  /** The agent changes the file (the tracker records it first). */
  const agentWrites = async (content: string) => {
    await changes.recordBefore(file());
    writeFileSync(file(), content);
  };
  /** The user saves the file in the editor. */
  const userSaves = (content: string, at = file()) => {
    const before = read();
    writeFileSync(file(), content);
    changes.noteUserEdit(at, before, content);
  };
  beforeEach(() => {
    ws = tempWorkspace();
    writeFileSync(file(), 'a0\n');
    host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    changes = new ChangeTracker(host);
  });
  afterEach(() => ws.cleanup());

  it('keeps a file the user saved after the capture it would go back to', async () => {
    changes.startEpoch();
    await agentWrites('agent\n');
    userSaves('mine\n');
    assert.deepEqual(await changes.rewindPreview(0), { restore: [], keep: ['a.txt'] });
    assert.deepEqual(await changes.rewindTo(0), { restored: [], kept: ['a.txt'] });
    assert.equal(read(), 'mine\n');
  });

  it("restores a capture taken after the user's save: it holds the user's content", async () => {
    changes.startEpoch();
    await agentWrites('agent\n');
    changes.startEpoch();
    userSaves('mine\n');
    changes.startEpoch();
    await agentWrites('agent again\n');
    assert.deepEqual(await changes.rewindTo(2), { restored: ['a.txt'], kept: [] });
    assert.equal(read(), 'mine\n');
    // Going further back would undo the save: kept.
    await agentWrites('agent once more\n');
    assert.deepEqual(await changes.rewindTo(0), { restored: [], kept: ['a.txt'] });
    assert.equal(read(), 'agent once more\n');
  });

  it('a new rewind point after going back is captured after the save', async () => {
    changes.startEpoch();
    changes.startEpoch();
    await agentWrites('agent\n');
    userSaves('mine\n');
    // Epoch 1 is dropped; the next request reuses its number and captures the user's content.
    assert.deepEqual(await changes.rewindTo(1), { restored: [], kept: ['a.txt'] });
    changes.startEpoch();
    await agentWrites('agent again\n');
    assert.deepEqual(await changes.rewindTo(1), { restored: ['a.txt'], kept: [] });
    assert.equal(read(), 'mine\n');
  });

  it('protects a kept change: saved after Keep All, or saved before it', async () => {
    changes.startEpoch();
    await agentWrites('agent\n');
    changes.acceptAll();
    userSaves('mine\n');
    assert.equal(changes.isUserEdited(file()), false, 'nothing to revert, so no Revert guard');
    assert.deepEqual(await changes.rewindTo(0), { restored: [], kept: ['a.txt'] });
    assert.equal(read(), 'mine\n');

    changes.startEpoch();
    await agentWrites('agent 2\n');
    userSaves('mine 2\n');
    changes.acceptAll();
    assert.deepEqual(await changes.rewindPreview(0), { restore: [], keep: ['a.txt'] });
    assert.deepEqual(await changes.rewindTo(0), { restored: [], kept: ['a.txt'] });
    assert.equal(read(), 'mine 2\n');
  });

  it('after Compact, a save is followed by new rewind points that capture it', async () => {
    changes.startEpoch();
    await agentWrites('agent\n');
    userSaves('mine\n');
    changes.clearEpochs();
    assert.equal(changes.isUserEdited(file()), true, 'Revert still leaves the file alone');
    changes.startEpoch();
    await agentWrites('agent again\n');
    assert.deepEqual(await changes.rewindTo(0), { restored: ['a.txt'], kept: [] });
    assert.equal(read(), 'mine\n');
  });

  it('matches a path that differs only in case (Windows)', async (t) => {
    if (process.platform !== 'win32') return t.skip('paths are case-sensitive here');
    changes.startEpoch();
    await agentWrites('agent\n');
    userSaves('mine\n', path.join(ws.root, 'A.TXT'));
    assert.equal(changes.isUserEdited(file()), true);
    assert.deepEqual(await changes.rewindTo(0), { restored: [], kept: ['a.txt'] });
    assert.equal(read(), 'mine\n');
  });

  it('the orchestrator reports kept files, and previews them before going back', async () => {
    const provider = new ScriptedProvider([() => [call('edit_file', { path: 'a.txt', old_string: 'a0', new_string: 'a1' })], () => [text('a is a1.')]]);
    const orchestrator = new Orchestrator({ host, getProvider: () => provider, permissions: new PermissionManager('autonomous'), getSettings: () => SETTINGS });
    await orchestrator.run('make it a1');
    const before = read();
    writeFileSync(file(), 'mine\n');
    orchestrator.changes.noteUserEdit(file(), before, 'mine\n');
    const [first] = orchestrator.rewindTargets;
    assert.deepEqual(await orchestrator.rewindPreview(first.id), { restore: [], keep: ['a.txt'] });
    const result = await orchestrator.rewind(first.id);
    assert.deepEqual([result?.restored, result?.kept], [[], ['a.txt']]);
    assert.equal(read(), 'mine\n');
    assert.equal(await orchestrator.rewindPreview(first.id), undefined);
  });
});
