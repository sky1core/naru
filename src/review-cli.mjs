import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './client.mjs';
import { readUTF8File } from './cli-files.mjs';
import { loadReviewFiles, composeReviewPrompt, writeReviewOutput } from './review-files.mjs';
import { commandSchema, requestSchema, requestIdSchema, deadlineMsSchema, defaultReviewDeadlineMs, RelayError, maxRequestBytes } from './protocol.mjs';

const invalid = (message) => new RelayError('invalid_arguments', message, 400);
const inputHash = (command) => createHash('sha256').update(composeReviewPrompt({
  id: command.reviewId, question: command.question, files: command.files, part: command.part, continueFrom: command.continueFrom,
})).digest('hex');

function assertReview(checkpoint, record) {
  if (record.id !== checkpoint.reviewId || record.promptHash !== checkpoint.promptHash || record.effort !== checkpoint.command.effort) {
    throw new RelayError('checkpoint_mismatch', 'Recorded review input differs from the output checkpoint.');
  }
  return record;
}

async function post(call, command, deadlineMs, id = randomUUID()) {
  const request = requestSchema.parse({ id, command, deadlineMs });
  console.error(JSON.stringify({ requestId: request.id }));
  return (await call('/v1/commands', request)).result;
}

async function loadCheckpoint(path, profile) {
  const checkpoint = JSON.parse(await readUTF8File(path));
  const parsed = commandSchema.safeParse(checkpoint.command);
  if (checkpoint.version !== 2 || checkpoint.profile !== profile || !requestIdSchema.safeParse(checkpoint.prepareRequestId).success ||
      !parsed.success || parsed.data.action !== 'review.prepare' || checkpoint.reviewId !== parsed.data.reviewId ||
      checkpoint.promptHash !== inputHash(parsed.data)) {
    throw new RelayError('checkpoint_mismatch', 'Checkpoint must contain the original input, its hash, and this profile.');
  }
  return checkpoint;
}

async function requireNewOutput(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new RelayError('output_exists', 'Output already exists; no request was submitted.');
}

async function inputCommand(values) {
  if (values.request) {
    if (values.question !== undefined || values.file?.length || values.id !== undefined || values['base-dir'] !== undefined || values.effort !== undefined || values.part !== undefined || values['continue-from'] !== undefined) {
      throw invalid('--request cannot be combined with source input options.');
    }
    const command = commandSchema.parse(JSON.parse(await readUTF8File(values.request)));
    if (command.action !== 'review.prepare') throw invalid('--request requires a prepared review input file.');
    return command;
  }
  if (!values.question?.trim()) throw invalid('--question is required.');
  const files = await loadReviewFiles(values.file || [], { baseDir: values['base-dir'] === undefined ? process.cwd() : resolve(values['base-dir']) });
  let part;
  if (values.part !== undefined) {
    const match = values.part.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
    if (!match) throw invalid('--part requires N/TOTAL with TOTAL >= 2.');
    part = { index: Number(match[1]), total: Number(match[2]) };
  }
  let continueFrom;
  if (values['continue-from'] !== undefined) {
    const profile = await realpath(resolve(values.profile));
    const previousOutput = resolve(values['continue-from']);
    const previous = await loadCheckpoint(`${previousOutput}.request.json`, profile);
    let answer;
    try { answer = await readFile(previousOutput); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    continueFrom = { reviewId: previous.reviewId, promptHash: previous.promptHash, effort: previous.command.effort,
      ...(answer === undefined ? {} : { answerHash: createHash('sha256').update(answer).digest('hex') }) };
  }
  const command = commandSchema.parse({ action: 'review.prepare', part, continueFrom, reviewId: values.id === undefined ? randomUUID() : values.id, question: values.question, files, effort: values.effort });
  return command;
}

function assertRequestSize(command, deadlineMs = defaultReviewDeadlineMs) {
  const bytes = Buffer.byteLength(JSON.stringify({ id: randomUUID(), deadlineMs, command }));
  if (bytes > maxRequestBytes) throw new RelayError('body_too_large', 'Review input exceeds the 8 MiB API request limit. No source was truncated or sent.', 413);
}

async function collect(call, checkpoint, out, timeoutMs, deadlineMs) {
  const id = checkpoint.reviewId;
  const until = Date.now() + timeoutMs;
  const expired = () => new RelayError('review_pending',
    `Review ${id} was not collected within the total timeout. Inspect the existing request ID and collect the same output again; do not submit another request.`, 408);
  const remainingTime = () => timeoutMs === 0 ? deadlineMs : until - Date.now();
  const limitedCall = async (path, body) => {
    const remaining = remainingTime();
    if (remaining <= 0) throw expired();
    try {
      const result = await call(path, body, { timeoutMs: timeoutMs === 0 ? 150000 : Math.min(150000, remaining) });
      if (timeoutMs > 0 && Date.now() >= until) throw expired();
      return result;
    } catch (error) {
      if (timeoutMs > 0 && Date.now() >= until && ['connection_lost', 'command_timeout'].includes(error.code)) throw expired();
      throw error;
    }
  };
  assertReview(checkpoint, await limitedCall(`/v1/reviews/${id}`));
  while (true) {
    const remaining = remainingTime();
    if (remaining <= 0) throw expired();
    const waitBudget = Math.min(deadlineMs, remaining);
    const waitMs = timeoutMs === 0 ? 0 : Math.max(0, Math.min(30000, remaining, waitBudget - 250));
    const review = assertReview(checkpoint, await post(limitedCall, { action: 'review.collect', reviewId: id, waitMs }, deadlineMs));
    if (review.state === 'completed') {
      await writeReviewOutput(out, review.answer);
      return { reviewId: id, state: review.state, output: resolve(out), responseId: review.responseId };
    }
    if (Date.now() >= until) throw new RelayError('review_pending',
      `Review ${id} is not complete (${review.observation?.state}). Collect the same output again; do not submit another request.`, 408);
    if (waitMs === 0) await delay(Math.min(until - Date.now(), review.observation.retryAfterMs));
  }
}

export async function reviewCLI(action, arg, values) {
  if (['collect', 'submit', 'doctor', 'review-status'].includes(action) &&
      (values.question !== undefined || values.file?.length || values.request !== undefined || values['base-dir'] !== undefined || values.effort !== undefined || values.part !== undefined || values['continue-from'] !== undefined)) {
    throw invalid(`${action} does not accept new review input.`);
  }
  if (action === 'review-status') {
    if (!requestIdSchema.safeParse(arg).success) throw invalid('review-status requires a review UUID.');
    const call = await connect(resolve(values.profile));
    const { prompt, answer, ...status } = await call(`/v1/reviews/${arg}`);
    return { ...status, promptCharacters: prompt.length, answerCharacters: answer?.length };
  }
  if (arg) throw invalid('Unexpected positional argument.');
  if (action === 'doctor') {
    const call = await connect(resolve(values.profile));
    const view = await call('/v1/review-ui');
    return { url: view.url, layout: view.layout, composer: view.composer, send: view.send, sendEnabled: view.sendEnabled,
      busy: view.busy, messageCount: view.messages.length, problem: view.problem,
      draftPresent: Boolean(view.draft), attachments: view.attachments };
  }
  if (!values.out) throw invalid(`${action} requires --out.`);
  const out = resolve(values.out);
  if (action === 'prepare') {
    const command = await inputCommand(values);
    assertRequestSize(command);
    await writeReviewOutput(out, `${JSON.stringify(command, null, 2)}\n`);
    return { reviewId: command.reviewId, state: 'prepared', file: out, files: command.files.length };
  }
  const timeoutMs = values.timeout === undefined ? 1800000 : Number(values.timeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw invalid('--timeout must be a nonnegative integer in milliseconds.');
  const parsedDeadline = deadlineMsSchema.safeParse(values.deadline === undefined ? defaultReviewDeadlineMs : Number(values.deadline));
  if (!parsedDeadline.success) throw invalid('--deadline must be an integer from 1 to 120000 milliseconds.');
  const deadlineMs = parsedDeadline.data;
  await requireNewOutput(out);
  const profile = await realpath(resolve(values.profile));
  const call = await connect(profile);
  const checkpointPath = `${out}.request.json`;
  if (action === 'collect' || action === 'submit') {
    const checkpoint = await loadCheckpoint(checkpointPath, profile);
    if (values.id !== undefined && values.id !== checkpoint.reviewId) throw invalid('--id differs from the output checkpoint.');
    console.error(JSON.stringify({ reviewId: checkpoint.reviewId, checkpoint: checkpointPath }));
    if (action === 'submit') {
      let record;
      try { record = await call(`/v1/reviews/${checkpoint.reviewId}`); }
      catch (error) { if (error.code !== 'review_missing') throw error; }
      if (!record) {
        assertRequestSize(checkpoint.command, deadlineMs);
        record = await post(call, checkpoint.command, deadlineMs);
      }
      assertReview(checkpoint, record);
      const status = await call('/v1/status');
      await post(call, { action: 'review.submit', reviewId: checkpoint.reviewId, documentId: status.documentId }, deadlineMs);
    }
    return collect(call, checkpoint, out, timeoutMs, deadlineMs);
  }
  const command = await inputCommand(values);
  assertRequestSize(command, deadlineMs);
  const checkpoint = { version: 2, reviewId: command.reviewId, profile, command, promptHash: inputHash(command), prepareRequestId: randomUUID() };
  await writeReviewOutput(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  console.error(JSON.stringify({ reviewId: command.reviewId, checkpoint: checkpointPath }));
  assertReview(checkpoint, await post(call, command, deadlineMs, checkpoint.prepareRequestId));
  const status = await call('/v1/status');
  await post(call, { action: 'review.submit', reviewId: command.reviewId, documentId: status.documentId }, deadlineMs);
  return collect(call, checkpoint, out, timeoutMs, deadlineMs);
}
