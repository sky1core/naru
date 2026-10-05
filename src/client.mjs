import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RelayError } from './protocol.mjs';

export async function connect(profile) {
  const descriptor = JSON.parse(await readFile(join(profile, 'connection.json'), 'utf8'));
  const origin = new URL(descriptor.origin);
  if (descriptor.version !== 1 || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token)) {
    throw new RelayError('invalid_connection', 'Invalid local connection descriptor.', 400);
  }
  return async (path, body, { timeoutMs = 150000 } = {}) => {
    let response;
    let result;
    try {
      response = await fetch(`${descriptor.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${descriptor.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      result = await response.json();
    } catch {
      throw new RelayError('connection_lost', 'Connection failed or timed out. Inspect the original request ID before another action; do not resend automatically.', 503);
    }
    if (!response.ok) {
      const error = new RelayError(result.error.code, result.error.message, response.status);
      error.record = result;
      throw error;
    }
    return result;
  };
}
