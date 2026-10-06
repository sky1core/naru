import { constants } from 'node:fs';
import { open, stat, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayError } from './protocol.mjs';

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const writeFailure = () => new RelayError('review_output_write_failed', 'Unable to publish and synchronize review output.');

function publish(directory, fd, name, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./output-writer-child.mjs', import.meta.url))], {
      cwd: directory,
      stdio: ['ignore', 'ignore', 'ignore', fd, 'ipc'],
      serialization: 'advanced',
    });
    let result, failed = false;
    child.on('message', message => {
      if (result !== undefined) failed = true;
      result = message;
    });
    child.on('error', () => { failed = true; });
    child.once('close', code => {
      if (failed || code !== 0 || !result) reject(writeFailure());
      else if (result.error === 'review_output_exists') {
        reject(new RelayError('review_output_exists', 'Review output already exists; it was not overwritten.'));
      } else if (result.error || typeof result.dev !== 'bigint' || typeof result.ino !== 'bigint') {
        reject(writeFailure());
      } else resolve(result);
    });
    child.send({ name, text }, error => { if (error) failed = true; });
  });
}

export async function publishReviewOutput(output, text) {
  const directory = dirname(output);
  let directoryHandle, failure;
  try {
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const directoryIdentity = await directoryHandle.stat({ bigint: true });
    const fileIdentity = await publish(directory, directoryHandle.fd, basename(output), text);
    if (!sameIdentity(directoryIdentity, await stat(directory, { bigint: true }))) throw writeFailure();
    const published = await lstat(output, { bigint: true });
    if (!sameIdentity(fileIdentity, published) || !published.isFile() || (published.mode & 0o777n) !== 0o600n) {
      throw writeFailure();
    }
    if (!sameIdentity(directoryIdentity, await stat(directory, { bigint: true }))) throw writeFailure();
  } catch (error) {
    failure = error instanceof RelayError ? error : writeFailure();
  } finally {
    if (directoryHandle) {
      try { await directoryHandle.close(); }
      catch { failure = writeFailure(); }
    }
  }
  if (failure) throw failure;
  return output;
}
