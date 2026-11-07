// A tiny stdio MCP server for tests: two tools, one read-only and one destructive.
let buffer = '';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.stdout.write('fake-mcp starting (a log line that is not JSON)\n');

const tools = [
  {
    name: 'get_scene',
    description: 'List the GameObjects in the open scene.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'delete_object',
    description: 'Delete a GameObject by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    annotations: { destructiveHint: true },
  },
];

// FAKE_MCP_EXTRA=1: two more tools for the limit tests (a large result, a slow call).
// FAKE_MCP_START_DELAY=<ms>: answer initialize only after that long (a slow start).
if (process.env.FAKE_MCP_EXTRA === '1') {
  tools.push(
    { name: 'big_output', description: 'Return size characters.', inputSchema: { type: 'object', properties: { size: { type: 'number' } } } },
    { name: 'slow', description: 'Answer after ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  );
}
const startDelay = Number(process.env.FAKE_MCP_START_DELAY ?? 0);

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === 'initialize' && startDelay) {
    setTimeout(() => handle({ ...message, method: 'initialize-now' }), startDelay);
  } else if (message.method === 'initialize' || message.method === 'initialize-now') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-unity', version: '1.0.0' } } });
    // Servers may ping the client and send notifications; the client must cope.
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' });
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    if (name === 'big_output') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'x'.repeat(args.size) }] } });
    else if (name === 'slow') setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'done' }] } }), args.ms);
    else if (name === 'get_scene') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Main Camera\nPlayer\nEnemy' }] } });
    else if (name === 'delete_object') {
      const ok = args.name === 'Enemy';
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: ok ? `Deleted ${args.name}` : `No object named ${args.name}` }], isError: !ok } });
    } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool ${name}` } });
  } else if (message.id !== undefined && message.method) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported' } });
  }
}
