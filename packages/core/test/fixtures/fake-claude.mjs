// Emulates `claude -p --input-format stream-json --output-format stream-json` for tests.
// FAKE_CC_SCRIPT: JSON array, one entry per user message: a reply text ("__ERROR__:msg" for an
//   error result), or { events: [...] } to write those stream-json lines as they are, followed by a
//   successful result (unless the list has one).
// FAKE_CC_LOG: file that receives one JSON line per received user message.
// FAKE_CC_HOLD: a file; each reply streams its first part, then waits until that file exists
//   (a turn that is still running meanwhile), and removes it, so the next reply waits again.
// FAKE_CC_CRASHED: a file; a "__CRASH_ONCE__:text" reply streams a little and exits (code 3) while
//   the file is missing, then creates it, so the next process answers with the text.
// "--version" and "auth status" answer at once, as the real CLI does.
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';

const replies = JSON.parse(process.env.FAKE_CC_SCRIPT || '[]');
const log = process.env.FAKE_CC_LOG;
const hold = process.env.FAKE_CC_HOLD;
const argv = process.argv.slice(2);
let turn = 0;
let buffer = '';
let queue = Promise.resolve();

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write('{"loggedIn":true,"email":"dev@example.test","authMethod":"claude.ai","subscriptionType":"pro"}\n');
  process.exit(0);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      queue = queue.then(() => handle(message));
    }
  }
});

const held = () =>
  new Promise((resolve) => {
    const check = () => (existsSync(hold) ? (rmSync(hold, { force: true }), resolve()) : setTimeout(check, 50));
    check();
  });

async function handle(message) {
  const text = message.message.content;
  if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, turn, text, argv, configDir: process.env.CLAUDE_CONFIG_DIR ?? null })}\n`);
  const reply = replies[turn++] ?? 'no more scripted replies';
  out({ type: 'system', subtype: 'init', model: 'claude-fake-1', tools: [] });
  if (typeof reply === 'object') {
    for (const event of reply.events) out(event);
    if (hold) await held();
    if (!reply.events.some((e) => e.type === 'result')) out({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', usage: {} });
    return;
  }
  if (typeof reply === 'string' && reply.startsWith('__CRASH_ONCE__:') && !existsSync(process.env.FAKE_CC_CRASHED)) {
    writeFileSync(process.env.FAKE_CC_CRASHED, 'crashed');
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Half an ans' } } });
    setTimeout(() => process.exit(3), 50);
    return;
  }
  if (typeof reply === 'string' && reply.startsWith('__CRASH_ONCE__:')) return answer(reply.slice('__CRASH_ONCE__:'.length));
  if (reply.startsWith('__ERROR__:')) {
    const error = reply.slice('__ERROR__:'.length);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: error }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: error, usage: {} });
    return;
  }
  return answer(reply);
}

async function answer(reply) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } });
  // Stream in small uneven chunks so tags get split across deltas.
  for (let i = 0; i < reply.length; i += 7) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: reply.slice(i, i + 7) } } });
    if (hold && i === 0) await held();
  }
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: reply,
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    modelUsage: { 'claude-test': { inputTokens: 11, contextWindow: 200000 } },
  });
}
