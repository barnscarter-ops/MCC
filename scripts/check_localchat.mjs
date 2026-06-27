// Self-check for the local-model executor wiring (lib/models.mjs localChat).
// Run: node scripts/check_localchat.mjs
// Asserts: (1) localChat hits an OpenAI-compatible endpoint and returns the text;
//          (2) a dead endpoint throws — which is what triggers the OpenRouter
//          fallback in chat.mjs delegateWriteToExecutor.
import http from 'node:http';
import assert from 'node:assert/strict';

// Mock OpenAI-compatible server on an ephemeral port.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const sent = JSON.parse(body);
    assert.equal(sent.messages.at(-1).content, 'ping', 'request body must carry the messages');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

// Import AFTER setting the env so config.mjs picks up the mock URL.
process.env.LOCAL_MODEL_URL = `http://127.0.0.1:${port}/v1`;
const { localChat } = await import('../lib/models.mjs');

// (1) happy path
const out = await localChat([{ role: 'user', content: 'ping' }]);
assert.equal(out, 'pong', 'localChat should return the assistant content');

// (2) dead endpoint throws (fallback trigger)
server.close();
const { localChat: lc2 } = await import('../lib/models.mjs');
await assert.rejects(
  () => lc2([{ role: 'user', content: 'ping' }]),
  'localChat must throw when the local server is offline (so OpenRouter fallback fires)'
);

console.log('OK: localChat parses responses and throws on a dead endpoint.');
