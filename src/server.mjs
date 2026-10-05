import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Journal } from './journal.mjs';
import { Reviews } from './review.mjs';
import { RelayError, publicError, requestSchema, maxRequestBytes } from './protocol.mjs';

async function readJSON(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) throw new RelayError('body_too_large', 'JSON request exceeds 8 MiB; no command executed.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RelayError('invalid_json', 'Request body must be valid UTF-8 JSON.', 400); }
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(`${JSON.stringify(body)}\n`);
}

function recordReply(response, record) {
  if (record.state === 'started') return reply(response, 409, { id: record.id, error: { code: 'outcome_unknown', message: 'Execution started; no final result is recorded. Never automatically resend with another ID.' } });
  reply(response, record.state === 'completed' ? 200 : record.status, record);
}

export async function startServer({ browser, profile, quit }) {
  const token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const journal = new Journal(profile);
  const reviews = new Reviews(profile, browser);
  let active = null;
  let port;

  const server = createServer(async (request, response) => {
    try {
      const authorization = Buffer.from(request.headers.authorization || '');
      if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined ||
        authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
        throw new RelayError('unauthorized', 'Local bearer authentication is required; browser-origin requests are denied.', 401);
      }
      if (request.method === 'GET' && request.url === '/v1/status') return reply(response, 200, {
        ...browser.status(), execution: active ? { requestId: active.id, state: active.timedOut ? 'timed-out' : 'running' } : null,
      });
      if (request.method === 'GET' && request.url === '/v1/project') return reply(response, 200, reviews.project.get());
      if (request.method === 'GET' && request.url === '/v1/diagnostics') return reply(response, 200, browser.diagnostics());
      if (request.method === 'GET' && request.url === '/v1/snapshot') return reply(response, 200, await browser.snapshot());
      if (request.method === 'GET' && request.url === '/v1/review-ui') return reply(response, 200, await browser.reviewView());
      if (request.method === 'GET' && request.url.startsWith('/v1/reviews/')) {
        const id = request.url.slice('/v1/reviews/'.length);
        if (!z.uuid().safeParse(id).success) throw new RelayError('invalid_request_id', 'Expected UUID.', 400);
        const record = reviews.get(id);
        return reply(response, 200, record.state === 'completed' ? { ...record, error: undefined } : record);
      }
      if (request.method === 'GET' && request.url.startsWith('/v1/requests/')) {
        const id = request.url.slice('/v1/requests/'.length);
        if (!z.uuid().safeParse(id).success) throw new RelayError('invalid_request_id', 'Expected UUID.', 400);
        const record = journal.get(id);
        if (!record) throw new RelayError('request_missing', 'No execution record exists for this ID.', 404);
        return recordReply(response, record);
      }
      if (request.method !== 'POST' || request.url !== '/v1/commands') throw new RelayError('route_missing', 'Unknown endpoint.', 404);
      if (request.headers['content-type'] !== 'application/json') throw new RelayError('invalid_content_type', 'Expected application/json.', 415);
      const parsed = requestSchema.safeParse(await readJSON(request));
      if (!parsed.success) throw new RelayError('invalid_command', JSON.stringify(parsed.error.issues), 400);
      const { id, command, deadlineMs } = parsed.data;
      if (active && command.action !== 'quit' && !journal.get(id)) {
        throw new RelayError(active.timedOut ? 'browser_unresponsive' : 'busy',
          active.timedOut ? 'Previous command has not settled. No new input is allowed; status, diagnostics and quit remain available.' : 'Another command is running; this command was not started.', 409);
      }
      const { fresh, record } = journal.begin(id, { command, deadlineMs });
      if (!fresh) return recordReply(response, record);
      if (command.action === 'quit') {
        const final = journal.finish(record, { state: 'completed', result: { quitting: true } });
        response.once('finish', quit);
        recordReply(response, final);
        return;
      }
      const controller = new AbortController();
      const current = { id, timedOut: false };
      active = current;
      let timer;
      const deadlineAt = Date.now() + deadlineMs;
      const expire = () => {
        if (!current.timedOut) {
          current.timedOut = true;
          controller.abort();
        }
        return { state: 'uncertain', status: 504, error: { code: 'command_timeout',
          message: 'Execution deadline expired. Already dispatched effects may have occurred; no further input will be dispatched. Never automatically resend.' } };
      };
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(expire()), Math.max(0, deadlineAt - Date.now())); });
      const execute = async () => {
        if (command.action === 'project.bind') return reviews.project.bind(command.documentId, controller.signal);
        if (command.action === 'project.open') return reviews.project.open(controller.signal, deadlineAt);
        if (command.action === 'review.prepare') return reviews.prepare(command);
        if (command.action === 'review.submit') return reviews.submit(command.reviewId, command.documentId, controller.signal, deadlineAt);
        if (command.action === 'review.collect') return reviews.collect(command.reviewId, command.waitMs, controller.signal, deadlineAt);
        return browser.execute(command, controller.signal, deadlineAt);
      };
      const execution = execute().then(
        (result) => Date.now() >= deadlineAt ? expire() : ({ state: 'completed', result }),
        (error) => {
          if (Date.now() >= deadlineAt) return expire();
          if (!(error instanceof RelayError)) console.error(error);
          return { state: 'failed', status: error.status || 500, error: publicError(error) };
        },
      ).finally(() => {
        if (active === current) active = null;
      });
      const outcome = await Promise.race([execution, deadline]);
      clearTimeout(timer);
      recordReply(response, journal.finish(record, outcome));
    } catch (error) {
      if (!(error instanceof RelayError)) console.error(error);
      if (!response.headersSent) reply(response, error.status || 500, { error: publicError(error) });
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  return { server, descriptor: { version: 1, pid: process.pid, origin: `http://127.0.0.1:${port}`, token } };
}
