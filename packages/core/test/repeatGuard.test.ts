import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHost } from '../src/host/NodeHost';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { collapseRepeats, REPEAT_LIMIT, RepeatGuard } from '../src/orchestrator/repeatGuard';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { ClaudeCodeProvider } from '../src/providers/ClaudeCodeProvider';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { text, ScriptedProvider, tempWorkspace } from './helpers';

const FAKE_CLI = path.resolve(__dirname, '../../test/fixtures/fake-claude.mjs');

describe('RepeatGuard', () => {
  it('names a short line that comes the limit times in a row, across chunks and blank lines', () => {
    const guard = new RepeatGuard(4);
    assert.equal(guard.push('Intro\n_place'), undefined);
    assert.equal(guard.push('holder\n\n_placeholder\n_placeholder\n'), undefined);
    assert.equal(guard.push('_placeholder\n'), '_placeholder');
  });

  it('leaves ordinary text alone: other lines in between, and long lines', () => {
    const guard = new RepeatGuard(3);
    assert.equal(guard.push('a\na\nb\na\na\n'), undefined);
    const long = 'x'.repeat(200);
    assert.equal(guard.push(`${long}\n${long}\n${long}\n${long}\n`), undefined);
  });

  it('allows far more repeats in a code block: a tilemap or a YAML excerpt may repeat a line on purpose', () => {
    const guard = new RepeatGuard(3);
    assert.equal(guard.push(`Here:\n\`\`\`csharp\n${'{0,0,0},\n'.repeat(29)}~~~\n\`\`\`\n`), undefined);
    assert.equal(guard.push(`~~~yaml\n${'- {fileID: 0}\n'.repeat(29)}~~~\n`), undefined);
    assert.equal(guard.push('again\nagain\nagain\n'), 'again', 'after the block, a loop counts as before');
    assert.equal(guard.push(`\`\`\`\n${'x\n'.repeat(30)}`), 'x', 'a block that only loops is still stopped');
  });

  it('keeps one copy of the line when the answer is cut', () => {
    assert.equal(collapseRepeats('Intro\n_placeholder\n_placeholder\n\n_placeholder', '_placeholder'), 'Intro\n_placeholder');
  });
});

describe('a model that repeats itself', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  function run(provider: ConstructorParameters<typeof Orchestrator>[0]['getProvider']) {
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    const orchestrator = new Orchestrator({
      host,
      getProvider: provider,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 30_000 }),
    });
    const events: AgentEvent[] = [];
    const session = emptySession();
    orchestrator.on((e) => {
      events.push(e);
      applyEvent(session, e);
    });
    return { orchestrator, events, session };
  }

  it('is stopped with a notice, the transcript keeps the line once, and the conversation goes on afterwards', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: i === 0 ? 'Sure.\n_placeholder\n' : '_placeholder\n' } },
    }));
    process.env.FAKE_CC_SCRIPT = JSON.stringify([
      { events: [{ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }, ...lines] },
      'Back to normal.',
    ]);
    delete process.env.FAKE_CC_LOG;
    delete process.env.FAKE_CC_HOLD;
    const provider = new ClaudeCodeProvider({ executable: process.execPath, executableArgs: [FAKE_CLI], model: 'haiku' });
    try {
      const { orchestrator, events, session } = run(() => provider);
      assert.equal(await orchestrator.run('Say hi'), 'error');
      const answer = session.items.find((i) => i.kind === 'assistant');
      assert.equal(answer?.kind === 'assistant' && answer.text, 'Sure.\n_placeholder');
      const streamed = events.flatMap((e) => (e.type === 'assistant_delta' ? [e.text] : [])).join('');
      assert.ok((streamed.match(/_placeholder/g) ?? []).length < REPEAT_LIMIT, 'the stream stops at the limit');
      const notice = events.find((e) => e.type === 'notice');
      assert.match(notice?.type === 'notice' ? notice.message : '', /same line \("_placeholder"\) 30 times in a row/);
      assert.equal(orchestrator.history.filter((m) => m.role === 'assistant').length, 0, 'the looping answer is not kept');

      // The next message starts a fresh CLI process (the looping one was ended) and works.
      process.env.FAKE_CC_SCRIPT = JSON.stringify(['Back to normal.']);
      assert.equal(await orchestrator.run('Again'), 'completed');
      assert.match(JSON.stringify(orchestrator.history.at(-1)), /Back to normal\./);
    } finally {
      provider.dispose();
    }
  });

  it('also when the provider finished the answer before it could be stopped', async () => {
    const provider = new ScriptedProvider([() => [text(`Start\n${'tick\n'.repeat(REPEAT_LIMIT + 5)}`)]]);
    const { orchestrator, session } = run(() => provider);
    assert.equal(await orchestrator.run('Count'), 'error');
    const answer = session.items.find((i) => i.kind === 'assistant');
    assert.equal(answer?.kind === 'assistant' && answer.text, 'Start\ntick');
    assert.equal(orchestrator.history.length, 1, 'only the request');
  });
});
