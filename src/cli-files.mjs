import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { RelayError, maxRequestBytes } from './protocol.mjs';
import { createJSONInput } from './json-input.mjs';
export { assertJSONInputSize } from './json-input.mjs';

export function assertAPIRequestSize(request) {
  const tooLarge = () => new RelayError('body_too_large', 'Input exceeds the 8 MiB API request limit. No source was truncated or sent.', 413);
  let stringBytes = 0;
  const countStrings = value => {
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value);
      if (stringBytes > maxRequestBytes) throw tooLarge();
    } else if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) countStrings(entry);
    }
  };
  countStrings(request);
  const bytes = Buffer.byteLength(JSON.stringify(request));
  if (bytes > maxRequestBytes) throw tooLarge();
  return bytes;
}

export async function readUTF8File(path, { maxBytes } = {}) {
  let handle;
  let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new RelayError('invalid_input_file', 'Input must be a regular file; no request was submitted.', 400);
    if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
      throw new RelayError('body_too_large', 'Input exceeds the API request input budget; no request was submitted.', 413);
    }
    const chunks = [];
    let remaining = before.size;
    while (remaining > 0n) {
      const chunk = Buffer.allocUnsafe(Number(remaining > 65536n ? 65536n : remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) throw new RelayError('input_file_changed', 'Input changed while being read; no request was submitted.', 400);
      chunks.push(chunk.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
    const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, null);
    const after = await handle.stat({ bigint: true });
    if (bytesRead || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
      throw new RelayError('input_file_changed', 'Input changed while being read; no request was submitted.', 400);
    }
    bytes = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('input_read_failed', 'Unable to read input file; no request was submitted.', 400);
  } finally {
    if (handle) await handle.close();
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new RelayError('invalid_utf8', 'Input file must contain valid UTF-8; no request was submitted.', 400); }
}

export async function readJSONFile(path, { kind = 'request', profile } = {}) {
  let handle, input, invalidUTF8 = false, invalidJSON = false;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const consume = bytes => {
    let text;
    try { text = bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }); }
    catch { invalidUTF8 = true; return; }
    if (!invalidJSON) {
      try { input.write(text); }
      catch { invalidJSON = true; }
    }
  };
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new RelayError('invalid_input_file', 'Input must be a regular file; no request was submitted.', 400);
    input = createJSONInput(kind, before.size, profile);
    let remaining = before.size;
    while (remaining > 0n) {
      const chunk = Buffer.allocUnsafe(Number(remaining > 65536n ? 65536n : remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) throw new RelayError('input_file_changed', 'Input changed while being read; no request was submitted.', 400);
      consume(chunk.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
    const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, null);
    const after = await handle.stat({ bigint: true });
    if (bytesRead || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
      throw new RelayError('input_file_changed', 'Input changed while being read; no request was submitted.', 400);
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('input_read_failed', 'Unable to read input file; no request was submitted.', 400);
  } finally {
    if (handle) await handle.close();
  }
  consume();
  if (invalidUTF8) throw new RelayError('invalid_utf8', 'Input file must contain valid UTF-8; no request was submitted.', 400);
  if (!invalidJSON) {
    try { return input.finish(); }
    catch { invalidJSON = true; }
  }
  throw new RelayError('invalid_json', 'Input file must contain valid JSON; no request was submitted.', 400);
}
