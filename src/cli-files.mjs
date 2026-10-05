import { readFile } from 'node:fs/promises';
import { RelayError } from './protocol.mjs';

export async function readUTF8File(path) {
  const bytes = await readFile(path);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new RelayError('invalid_utf8', 'Input file must contain valid UTF-8; no request was submitted.', 400); }
}
