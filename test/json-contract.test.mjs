import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readJSONFile, assertJSONInputSize } from '../src/cli-files.mjs';
import { commandSchema, requestSchema } from '../src/protocol.mjs';

test('streamed request files preserve every current command and its optional fields', async () => {
  const documentId = randomUUID(), reviewId = randomUUID();
  const target = { attribute: 'data-testid', value: 'composer', scope: { attribute: 'id', value: 'scope',
    scope: { attribute: 'data-app-shell-active-page', value: 'true' } } };
  const hash = createHash('sha256').update('source').digest('hex');
  const commands = [
    { action: 'navigate', url: 'https://example.com/?a=1#saved' },
    { action: 'fill', documentId, target, text: '한글🙂\u0000' },
    { action: 'click', documentId, target },
    { action: 'press', documentId, target, key: 'ArrowRight' },
    { action: 'read', documentId, target },
    { action: 'wait', documentId, target, state: 'absent', timeoutMs: 120000 },
    { action: 'screenshot' }, { action: 'quit' }, { action: 'project.bind', documentId }, { action: 'project.open' },
    { action: 'review.prepare', reviewId, question: 'Review', effort: 'pro', part: { index: 2, total: 2 },
      continueFrom: { effort: 'max', reviewId: randomUUID(), promptHash: hash, answerHash: hash },
      files: [{ path: 'source.txt', content: 'source', bytes: 6, sha256: hash }] },
    { action: 'review.submit', reviewId, documentId },
    { action: 'review.collect', reviewId, waitMs: 119000 },
  ];
  assert.deepEqual(new Set(commands.map(command => command.action)),
    new Set(commandSchema.options.map(schema => schema.shape.action.value)));
  const directory = await mkdtemp(join(tmpdir(), 'naru-json-contract-'));
  for (const command of commands) {
    const expected = { id: randomUUID(), deadlineMs: 120000, command };
    assert(requestSchema.safeParse(expected).success, command.action);
    const path = join(directory, `${command.action}.json`);
    await writeFile(path, JSON.stringify(expected));
    const actual = await readJSONFile(path, { kind: 'request' });
    const parsed = requestSchema.safeParse(actual);
    assert(parsed.success, command.action);
    assertJSONInputSize(actual, parsed);
    assert.deepEqual(actual, expected, command.action);
  }
});
