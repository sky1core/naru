import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/client.mjs';
import { startServer } from '../src/server.mjs';

const proof = (token, nonce, clientPort, serverPort) => createHmac('sha256', token)
  .update(`naru-server-identity-v1\n${nonce}\n${clientPort}\n${serverPort}`).digest('hex');
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function client(origin, token) {
  const profile = await mkdtemp(join(tmpdir(), 'naru-client-auth-'));
  await writeFile(join(profile, 'connection.json'), JSON.stringify({ version: 1, origin, token, pid: 2147483647 }));
  return connect(profile);
}

test('unverified endpoints receive neither bearer nor sensitive command', async t => {
  for (const mode of ['missing', 'forged', 'different-nonce', 'different-socket', 'redirect', 'replay']) await t.test(mode, async t => {
    const token = randomBytes(32).toString('hex');
    const seen = [];
    let replay;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      const nonce = req.headers['x-naru-nonce'];
      const other = 'a'.repeat(64);
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'redirect') { res.writeHead(307, { Location: '/v1/commands' }); res.end('{}'); }
      else if (mode === 'missing') { res.writeHead(404); res.end('{}'); }
      else if (mode === 'forged') res.end(JSON.stringify({ nonce, proof: 'b'.repeat(64) }));
      else if (mode === 'different-nonce') res.end(JSON.stringify({ nonce, proof: proof(token, other, req.socket.remotePort, req.socket.localPort) }));
      else if (mode === 'different-socket') res.end(JSON.stringify({ nonce, proof: proof(token, nonce, req.socket.remotePort + 1, req.socket.localPort) }));
      else {
        replay ??= { nonce, proof: proof(token, nonce || other, req.socket.remotePort, req.socket.localPort) };
        res.end(JSON.stringify(replay));
      }
    });
    const origin = await listen(server);
    t.after(() => close(server));
    const call = await client(origin, token);
    if (mode === 'replay') await call('/v1/status');
    const offset = seen.length;
    await assert.rejects(call('/v1/commands', { id: randomUUID(), command: { action: 'fill', text: 'PRIVATE INPUT' } }),
      error => { assert(!JSON.stringify(error).includes('PRIVATE INPUT')); return error.code === 'server_identity_unverified'; });
    assert.equal(seen.length - offset, 1);
    assert.equal(seen.at(-1).url, '/v1/identity');
    assert.equal(seen.at(-1).authorization, undefined);
    assert.equal(seen.at(-1).body, '');
  });
});

test('identity proof and command use exactly one socket; a closing authenticated socket cannot reconnect', async t => {
  for (const disconnect of [false, true]) await t.test(String(disconnect), async t => {
    const token = randomBytes(32).toString('hex');
    const seen = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ socket: req.socket, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/identity') {
        const nonce = req.headers['x-naru-nonce'];
        if (disconnect) res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ nonce, proof: proof(token, nonce || '', req.socket.remotePort, req.socket.localPort) }));
      } else res.end(JSON.stringify({ accepted: true }));
    });
    const origin = await listen(server);
    t.after(() => close(server));
    const call = await client(origin, token);
    const pending = call('/v1/commands', { text: 'PRIVATE INPUT' });
    if (disconnect) {
      await assert.rejects(pending);
      assert.equal(seen.length, 1);
    } else {
      assert.deepEqual(await pending, { accepted: true });
      assert.equal(seen.length, 2);
      assert.equal(seen[0].socket, seen[1].socket);
      assert.equal(seen[0].authorization, undefined);
      assert.equal(seen[1].authorization, `Bearer ${token}`);
      assert.equal(JSON.parse(seen[1].body).text, 'PRIVATE INPUT');
    }
  });
});

test('server death and port reuse reject the next command before transmitting secrets', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'naru-client-auth-'));
  const { server, descriptor } = await startServer({ profile, browser: { status: () => ({ ready: true }) }, quit() {} });
  await writeFile(join(profile, 'connection.json'), JSON.stringify(descriptor));
  const call = await connect(profile);
  assert.equal((await call('/v1/status')).ready, true);
  const port = server.address().port;
  await close(server);
  const seen = [];
  const replacement = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.end('{}');
  });
  await listen(replacement, port);
  t.after(() => close(replacement));
  await assert.rejects(call('/v1/commands', { text: 'PRIVATE INPUT' }), { code: 'server_identity_unverified' });
  assert.deepEqual(seen, [{ authorization: undefined, body: '' }]);
});

test('a forwarded genuine identity proof from another TCP connection cannot authorize disclosure', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'naru-client-auth-'));
  const genuine = await startServer({ profile, browser: {}, quit() {} });
  t.after(() => close(genuine.server));
  const seen = [];
  const relay = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    const upstream = request(genuine.descriptor.origin + '/v1/identity', {
      headers: { 'X-Naru-Nonce': req.headers['x-naru-nonce'] || 'a'.repeat(64) },
    }, response => { res.writeHead(response.statusCode); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(503); res.end('{}'); });
    upstream.end();
  });
  const origin = await listen(relay);
  t.after(() => close(relay));
  const call = await client(origin, genuine.descriptor.token);
  await assert.rejects(call('/v1/commands', { text: 'PRIVATE INPUT' }), { code: 'server_identity_unverified' });
  assert.deepEqual(seen, [{ authorization: undefined, body: '' }]);
});

test('production identity endpoint validates Host, Origin and nonce and preserves direct bearer calls', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'naru-client-auth-'));
  const { server, descriptor } = await startServer({ profile, browser: { status: () => ({ ready: true }) }, quit() {} });
  t.after(() => close(server));
  const nonce = randomBytes(32).toString('hex');
  async function identity(headers, path = '/v1/identity') {
    return new Promise((resolve, reject) => {
      const req = request(descriptor.origin + path, { headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), clientPort: req.socket.localPort }));
      });
      req.on('error', reject); req.end();
    });
  }
  const result = await identity({ 'X-Naru-Nonce': nonce });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { nonce, proof: proof(descriptor.token, nonce, result.clientPort, server.address().port) });
  for (const headers of [{ 'X-Naru-Nonce': nonce, Host: 'invalid.example' },
    { 'X-Naru-Nonce': nonce, Origin: 'https://example.com' }, {}, { 'X-Naru-Nonce': 'INVALID' }]) {
    const rejected = await identity(headers);
    assert(rejected.status >= 400);
    assert(!JSON.stringify(rejected.body).includes(descriptor.token));
    assert(!JSON.stringify(rejected.body).includes(nonce));
  }
  assert.equal((await identity({ Authorization: `Bearer ${descriptor.token}` }, '/v1/status')).status, 200);
});
