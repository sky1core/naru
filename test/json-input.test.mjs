import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJSONFile, assertAPIRequestSize, assertJSONInputSize } from '../src/cli-files.mjs';
import { maxRequestBytes, requestSchema } from '../src/protocol.mjs';

async function inputFile(source) {
  const dir = await mkdtemp(join(tmpdir(), 'json-input-'));
  const path = join(dir, 'input.json');
  await writeFile(path, source);
  return path;
}

function navigateRequest() {
  return { id: randomUUID(), command: { action: 'navigate', url: 'https://example.test/' } };
}

test('JSON formatting does not impose a raw file size limit on a valid API request', async () => {
  const expected = navigateRequest();
  const source = `${' \t\r\n'.repeat(4 * 1024 * 1024)}${JSON.stringify(expected)}\n`;
  assert(requestSchema.safeParse(expected).success);
  assert(assertAPIRequestSize(expected) < 256);
  assert(Buffer.byteLength(source) > 2 * maxRequestBytes);
  assert.deepEqual(await readJSONFile(await inputFile(source)), expected);
});

test('Unicode escapes may expand raw JSON beyond 16 MiB while the API request fits', async () => {
  const text = 'a'.repeat(3 * 1024 * 1024);
  const expected = { id: randomUUID(), command: { action: 'fill', documentId: randomUUID(),
    target: { attribute: 'id', value: 'composer' }, text } };
  const source = JSON.stringify(expected).replace(JSON.stringify(text), `"${'\\u0061'.repeat(text.length)}"`);
  assert(requestSchema.safeParse(expected).success);
  assert(assertAPIRequestSize(expected) < maxRequestBytes);
  assert(Buffer.byteLength(source) > 2 * maxRequestBytes);
  assert.deepEqual(await readJSONFile(await inputFile(source)), expected);
});

test('an oversized value replaced by an escaped duplicate key keeps JSON.parse last-wins semantics', async () => {
  const expected = navigateRequest();
  const source = `{"id":${JSON.stringify(expected.id)},"command":"${'x'.repeat(2 * maxRequestBytes + 1)}",` +
    `"\\u0063ommand":${JSON.stringify(expected.command)}}`;
  assert.deepEqual(JSON.parse(source), expected);
  assert(requestSchema.safeParse(expected).success);
  assert(assertAPIRequestSize(expected) < 256);
  assert.deepEqual(await readJSONFile(await inputFile(source)), expected);
});

test('discarded duplicate values remain subject to JSON syntax validation', async () => {
  for (const source of [
    '{"command":"bad\\q","command":{"action":"quit"}}',
    '{"command":[1,],"command":{"action":"quit"}}',
    '{"command":01,"command":{"action":"quit"}}',
  ]) {
    assert.throws(() => JSON.parse(source), SyntaxError);
    await assert.rejects(readJSONFile(await inputFile(source)), { code: 'invalid_json' });
  }
});

test('unknown strict API keys, including prototype keys, remain schema failures', async () => {
  for (const field of ['__proto__', 'constructor', 'prototype', 'x'.repeat(100000)]) {
    const expected = navigateRequest();
    const source = JSON.stringify(expected).replace(/}$/, `,"${field}":{"ignored":"value"}}`);
    const actual = await readJSONFile(await inputFile(source));
    const parsed = requestSchema.safeParse(actual);
    assert.equal(parsed.success, false);
    assert.doesNotThrow(() => assertJSONInputSize(actual, parsed));
    assert.equal(Object.getPrototypeOf(actual).polluted, undefined);
  }
});

test('deep values replaced by duplicate keys do not create a new depth condition', async () => {
  const expected = navigateRequest();
  const depth = 50000;
  const source = `{"id":${JSON.stringify(expected.id)},"command":${'['.repeat(depth)}0${']'.repeat(depth)},` +
    `"command":${JSON.stringify(expected.command)}}`;
  assert.deepEqual(JSON.parse(source), expected);
  assert.deepEqual(await readJSONFile(await inputFile(source)), expected);
});

test('UTF-8 and JSON escape sequences spanning read chunks preserve source values', async () => {
  for (const boundary of [65530, 65531, 65532, 65533, 65534, 65535]) {
    const expected = { id: randomUUID(), command: { action: 'fill', documentId: randomUUID(),
      target: { attribute: 'id', value: 'composer' }, text: '한글🙂🙂a' } };
    const json = JSON.stringify(expected).replace(JSON.stringify(expected.command.text), '"한글🙂\\ud83d\\ude42\\u0061"');
    for (const marker of ['한글', '\\ud83d']) {
      const prefixBytes = Buffer.byteLength(json.slice(0, json.indexOf(marker)));
      const source = `${' '.repeat(boundary - prefixBytes)}${json}\r\n`;
      assert.deepEqual(await readJSONFile(await inputFile(source)), JSON.parse(source));
    }
  }
  for (const ending of [[0xc3, 0x28], [0xf0, 0x9f, 0x99]]) {
    const invalid = Buffer.concat([Buffer.alloc(65535, 32), Buffer.from(ending)]);
    await assert.rejects(readJSONFile(await inputFile(invalid)), { code: 'invalid_utf8' });
  }
  const malformed = Buffer.concat([Buffer.from('bad JSON'), Buffer.from([0xf0, 0x9f, 0x99])]);
  await assert.rejects(readJSONFile(await inputFile(malformed)), { code: 'invalid_utf8' });
});

test('open objects may exceed the wire budget before all large fields are overwritten', async () => {
  const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'q', files: [
    { path: 'p', content: 'small', bytes: 5, sha256: 'a'.repeat(64) },
  ] };
  const source = JSON.stringify(command).replace('"path":"p","content":"small"',
    `"path":"${'x'.repeat(5 * 1024 * 1024)}","content":"${'y'.repeat(5 * 1024 * 1024)}","path":"p","content":"small"`);
  assert.deepEqual(await readJSONFile(await inputFile(source), { kind: 'command' }), command);
});

test('oversized final arrays reject, while duplicate files and command slots can replace them', async () => {
  const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'q', files: [] };
  const file = { path: 'p', content: 'x'.repeat(5 * 1024 * 1024), bytes: 0, sha256: 'a'.repeat(64) };
  const large = JSON.stringify({ ...command, files: [file, file] });
  const { commandSchema } = await import('../src/protocol.mjs');
  const actual = await readJSONFile(await inputFile(large), { kind: 'command' });
  assert.throws(() => assertJSONInputSize(actual, commandSchema.safeParse(actual)), { code: 'body_too_large' });
  const replaced = large.replace(/}$/, ',"files":[]}');
  assert.deepEqual(await readJSONFile(await inputFile(replaced), { kind: 'command' }), command);
  const request = { id: randomUUID(), command: { action: 'quit' } };
  const source = `{"id":"${request.id}","command":${large},"command":{"action":"quit"}}`;
  assert.deepEqual(await readJSONFile(await inputFile(source)), request);
});

function dyadicDecimal(numerator, exponent) {
  if (exponent >= 0) return (numerator << BigInt(exponent)).toString();
  const scale = -exponent;
  const digits = (numerator * 5n ** BigInt(scale)).toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

test('streamed numbers agree with native parsing at binary64 midpoints, subnormals and overflow', async () => {
  const midpoints = [
    dyadicDecimal(2n ** 53n + 1n, -53),
    dyadicDecimal(2n ** 53n + 3n, -53),
    dyadicDecimal(1n, -1075),
    dyadicDecimal(3n, -1075),
    dyadicDecimal(2n ** 53n - 1n, -1075),
    dyadicDecimal(2n ** 54n - 1n, 970),
  ];
  const lexemes = ['-0', '-0.' + '0'.repeat(100000), '1e400', '1e-400', '9007199254740993',
    '1.' + '0'.repeat(100000), '1' + '0'.repeat(100000) + 'e-100000',
    '0.' + '0'.repeat(100000) + '1e100001', '1e-' + '0'.repeat(100000) + '400',
    '1e' + '9'.repeat(100000), '1e-' + '9'.repeat(100000)];
  for (const midpoint of midpoints) {
    const fixed = midpoint.includes('.') ? midpoint : midpoint + '.0';
    const exact = fixed + '0'.repeat(2000);
    const scaled = BigInt(exact.replace('.', ''));
    const decimalPlaces = exact.length - exact.indexOf('.') - 1;
    for (const delta of [-1n, 0n, 1n]) {
      const digits = (scaled + delta).toString().padStart(decimalPlaces + 1, '0');
      const value = `${digits.slice(0, -decimalPlaces)}.${digits.slice(-decimalPlaces)}`;
      lexemes.push(value, '-' + value);
    }
  }
  for (const lexeme of lexemes) {
    const source = `{"id":"${randomUUID()}","deadlineMs":${lexeme},"command":{"action":"quit"}}`;
    const expected = JSON.parse(source);
    const actual = await readJSONFile(await inputFile(source));
    assert(Object.is(actual.deadlineMs, expected.deadlineMs), `Native number mismatch (${lexeme.slice(0, 80)})`);
    assert.equal(requestSchema.safeParse(actual).success, requestSchema.safeParse(expected).success);
  }
});
