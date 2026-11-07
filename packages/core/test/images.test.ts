import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { ClaudeCodeProvider } from '../src/providers/ClaudeCodeProvider';
import { toClaudeMessages } from '../src/providers/ClaudeProvider';
import { toGeminiContents } from '../src/providers/GeminiProvider';
import { FileTaskStore, IMAGE_NOT_KEPT, type TaskSnapshot } from '../src/persistence/TaskStore';
import { OpenAIProvider, toOpenAIMessages } from '../src/providers/OpenAIProvider';
import { IMAGE_NOT_SENT, modelTakesImages } from '../src/providers/vision';
import type { ChatMessage } from '../src/types';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { ScriptedProvider, tempWorkspace, text } from './helpers';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const withImage: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is wrong in this screenshot?' },
      { type: 'image', mediaType: 'image/png', data: PNG },
    ],
  },
];

describe('images', () => {
  it('every API provider sends attached images in its own format', () => {
    const claude = toClaudeMessages(withImage)[0].content as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(claude[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });

    const openai = toOpenAIMessages("SYS", withImage)[1] as unknown as { role: string; content: Array<Record<string, unknown>> };
    assert.deepEqual(openai.content, [
      { type: 'text', text: 'What is wrong in this screenshot?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);

    const gemini = toGeminiContents(withImage)[0].parts!;
    assert.deepEqual(gemini[1], { inlineData: { mimeType: 'image/png', data: PNG } });
  });

  describe('with the agent', () => {
    let ws: ReturnType<typeof tempWorkspace>;
    beforeEach(() => (ws = tempWorkspace()));
    afterEach(() => ws.cleanup());

    it('a request carries its images to the model; the chat shows their thumbnails', async () => {
      const main = new ScriptedProvider([
        (req) => {
          const blocks = req.messages[0].content;
          assert.equal(blocks[0].type, 'text');
          assert.deepEqual(blocks[1], { type: 'image', mediaType: 'image/png', data: PNG });
          return [text('The button is cut off.')];
        },
      ]);
      const orchestrator = new Orchestrator({
        host: new NodeHost({ workspaceRoot: ws.root }),
        getProvider: () => main,
        permissions: new PermissionManager('balanced'),
        getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 10_000 }),
      });
      const session = emptySession();
      orchestrator.on((e) => applyEvent(session, e));
      await orchestrator.run('What is wrong here?', undefined, [], {
        images: [{ name: 'shot.png', mediaType: 'image/png', data: PNG, thumb: 'data:image/jpeg;base64,AAAA' }],
      });
      const user = session.items.find((i) => i.kind === 'user');
      assert.deepEqual(user && user.kind === 'user' ? user.images : undefined, [{ name: 'shot.png', thumb: 'data:image/jpeg;base64,AAAA' }]);
    });

    it('Claude Code receives text and image blocks in one stream-json message', async () => {
      const log = path.join(ws.root, 'cli.jsonl');
      process.env.FAKE_CC_SCRIPT = JSON.stringify(['I see a cut-off button.']);
      process.env.FAKE_CC_LOG = log;
      const provider = new ClaudeCodeProvider({
        executable: process.execPath,
        executableArgs: [path.resolve(__dirname, '../../test/fixtures/fake-claude.mjs')],
      });
      try {
        const response = await provider.chat({ system: 'SYS', messages: withImage, tools: [] }, () => {});
        assert.equal(response.stopReason, 'end_turn');
        assert.ok(existsSync(log));
        const sent = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]).text;
        assert.ok(Array.isArray(sent), 'content is a block array');
        assert.match(sent[0].text, /What is wrong in this screenshot\?\n\n\[image attached\]/);
        assert.deepEqual(sent[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
      } finally {
        provider.dispose();
      }
    });
  });

  it('a model known to take text alone gets a line in place of each image, and the user a notice', async () => {
    for (const model of ['deepseek-chat', 'deepseek/deepseek-reasoner', 'o3-mini', 'gpt-3.5-turbo', 'codestral-latest', 'qwen2.5-coder:7b']) assert.equal(modelTakesImages(model), false, model);
    for (const model of ['gpt-6-astra', 'gpt-4o', 'claude-opus-5-5', 'gemini-3.8-flash', 'llava', 'deepseek-vl2', 'openai/gpt-4.1']) assert.equal(modelTakesImages(model), true, model);
    const textOnly = toOpenAIMessages('SYS', withImage, false)[1] as { role: string; content: unknown };
    assert.equal(textOnly.content, `What is wrong in this screenshot?

${IMAGE_NOT_SENT}`);

    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
        res.end(`data: ${JSON.stringify(chunk)}

data: [DONE]

`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const provider = new OpenAIProvider({ apiKey: 'k', model: 'deepseek-chat', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, providerId: 'custom:deepseek' });
      assert.equal(provider.acceptsImages, false);
      const notices: string[] = [];
      await provider.chat({ system: 'SYS', messages: withImage, tools: [] }, (e) => e.type === 'notice' && notices.push(e.message));
      assert.ok(!JSON.stringify(bodies[0]).includes(PNG), 'the image did not leave the machine');
      assert.match(notices[0]!, /deepseek-chat does not accept images, so the attached images were not sent/);
    } finally {
      server.close();
    }
  });

  it('a saved task keeps no image data; the chat keeps the thumbnails', async () => {
    const ws = tempWorkspace();
    try {
      const store = new FileTaskStore(path.join(ws.root, 'tasks'));
      const messages: ChatMessage[] = [
        ...withImage,
        { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'browser', input: { action: 'screenshot' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'Screenshot taken.', images: [{ type: 'image', mediaType: 'image/jpeg', data: PNG }] }] },
      ];
      const snapshot: TaskSnapshot = {
        version: 1,
        id: 'task-1',
        title: 'images',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages,
        subagentProfiles: [],
        usageByAgent: [],
        view: { items: [{ kind: 'user', images: [{ name: 'shot.png', thumb: 'data:image/jpeg;base64,AAAA' }] }] },
      };
      await store.save(snapshot);
      const raw = readFileSync(path.join(ws.root, 'tasks', 'task-1.json'), 'utf8');
      assert.ok(!raw.includes(PNG));
      assert.ok(raw.includes('data:image/jpeg;base64,AAAA'), 'the thumbnail stays for the chat');
      const loaded = (await store.load('task-1'))!;
      assert.deepEqual(loaded.messages[0].content[1], { type: 'text', text: IMAGE_NOT_KEPT });
      assert.deepEqual(loaded.messages[2].content[0], { type: 'tool_result', toolCallId: 't1', content: 'Screenshot taken.' });
      assert.equal(snapshot.messages[0].content[1].type, 'image', 'the running task still has its images');
    } finally {
      ws.cleanup();
    }
  });
});
