import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { RelayError } from './protocol.mjs';
import { verifyIdentity } from './server-identity.mjs';

function requestJSON(url, { agent, signal, headers, body, socket, maxBytes = Infinity }) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { agent, signal, method: body === undefined ? 'GET' : 'POST', headers }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) outgoing.destroy(new Error('Response exceeds identity limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, result: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          socket: outgoing.socket, reusable: outgoing.shouldKeepAlive && response.headers.connection !== 'close' }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    outgoing.on('socket', assigned => {
      if (socket && assigned !== socket) outgoing.destroy(new Error('Authenticated socket changed.'));
    });
    outgoing.end(body);
  });
}

export async function connect(profile) {
  const descriptor = JSON.parse(await readFile(join(profile, 'connection.json'), 'utf8'));
  const origin = new URL(descriptor.origin);
  if (descriptor.version !== 1 || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token)) {
    throw new RelayError('invalid_connection', 'Invalid local connection descriptor.', 400);
  }
  return async (path, body, { timeoutMs = 150000 } = {}) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
    const createConnection = agent.createConnection.bind(agent);
    let opened = false;
    agent.createConnection = (options, callback) => {
      if (opened) {
        callback(new Error('Authenticated connection cannot reconnect.'));
        return;
      }
      opened = true;
      return createConnection(options, callback);
    };
    let authenticated = false;
    let response;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const nonce = randomBytes(32).toString('hex');
      const identity = await requestJSON(`${origin.origin}/v1/identity`, {
        agent, signal, headers: { 'X-Naru-Nonce': nonce }, maxBytes: 4096,
      });
      if (identity.status !== 200 || !verifyIdentity(descriptor.token, nonce, identity.result, identity.socket) ||
          !identity.reusable || identity.socket.destroyed || !identity.socket.writable) {
        throw new Error('Server identity is not verified on an open socket.');
      }
      authenticated = true;
      response = await requestJSON(`${origin.origin}${path}`, {
        agent, signal, socket: identity.socket,
        headers: { Authorization: `Bearer ${descriptor.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status >= 300 && response.status < 400) throw new Error('Redirects are denied.');
    } catch {
      if (!authenticated) throw new RelayError('server_identity_unverified', 'Local server identity could not be verified; no bearer or command body was sent.', 503);
      throw new RelayError('connection_lost', 'Connection failed or timed out. Inspect the original request ID before another action; do not resend automatically.', 503);
    } finally {
      agent.destroy();
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new RelayError(response.result.error.code, response.result.error.message, response.status);
      error.record = response.result;
      throw error;
    }
    return response.result;
  };
}
