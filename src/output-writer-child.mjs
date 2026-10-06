import { constants, fstat, fsync, close } from 'node:fs';
import { open, stat, lstat, link, unlink, mkdtemp, rmdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const directoryFd = 3;
const descriptorStat = promisify(fstat);
const descriptorSync = promisify(fsync);
const descriptorClose = promisify(close);
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function write({ name, text }) {
  let file, fileIdentity, directoryIdentity, staging, stagingHandle, stagingIdentity;
  let inStaging = false, ownedTemporary = false, publishing = false, failure;
  const temporary = 'answer';
  const verifyFile = async path => {
    const current = await lstat(path, { bigint: true });
    if (!sameIdentity(fileIdentity, current) || !current.isFile() || (current.mode & 0o777n) !== 0o600n) {
      throw new Error('Output file changed.');
    }
  };
  const verifyParent = async () => {
    if (!sameIdentity(directoryIdentity, await stat('..', { bigint: true }))) throw new Error('Output directory changed.');
  };
  try {
    directoryIdentity = await descriptorStat(directoryFd, { bigint: true });
    if (!directoryIdentity.isDirectory() || !sameIdentity(directoryIdentity, await stat('.', { bigint: true }))) {
      throw new Error('Output directory changed.');
    }
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || basename(name) !== name
      || name.includes('\0') || typeof text !== 'string' || !text.isWellFormed()) throw new Error('Invalid output.');
    staging = await mkdtemp('.review-');
    stagingHandle = await open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    stagingIdentity = await stagingHandle.stat({ bigint: true });
    if (stagingIdentity.uid !== BigInt(process.getuid()) || (stagingIdentity.mode & 0o777n) !== 0o700n) {
      throw new Error('Output staging directory is not private.');
    }
    process.chdir(staging);
    inStaging = true;
    if (!sameIdentity(stagingIdentity, await stat('.', { bigint: true }))) throw new Error('Output staging directory changed.');
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownedTemporary = true;
    fileIdentity = await file.stat({ bigint: true });
    await file.chmod(0o600);
    await file.writeFile(text, 'utf8');
    await file.sync();
    await verifyParent();
    await verifyFile(temporary);
    publishing = true;
    await link(temporary, `../${name}`);
    publishing = false;
    await verifyParent();
    await verifyFile(`../${name}`);
    await unlink(temporary);
    ownedTemporary = false;
    await descriptorSync(directoryFd);
    await verifyParent();
    await verifyFile(`../${name}`);
  } catch (error) {
    failure = publishing && error.code === 'EEXIST' ? 'review_output_exists' : 'review_output_write_failed';
  } finally {
    for (const cleanup of [
      async () => { if (file) await file.close(); },
      async () => { if (ownedTemporary) { await verifyFile(temporary); await unlink(temporary); } },
      async () => {
        if (!stagingIdentity) return;
        if (inStaging) {
          if (!sameIdentity(stagingIdentity, await stat('.', { bigint: true }))) throw new Error('Output staging directory changed.');
          process.chdir('..');
        }
        if (!sameIdentity(directoryIdentity, await stat('.', { bigint: true })) ||
            !sameIdentity(stagingIdentity, await lstat(staging, { bigint: true }))) throw new Error('Output directory changed.');
        await rmdir(staging);
        await descriptorSync(directoryFd);
      },
      async () => { if (stagingHandle) await stagingHandle.close(); },
      async () => { await descriptorClose(directoryFd); },
    ]) {
      try { await cleanup(); }
      catch { failure ??= 'review_output_write_failed'; }
    }
  }
  return failure ? { error: failure } : { dev: fileIdentity.dev, ino: fileIdentity.ino };
}

process.once('message', async message => {
  let result;
  try { result = await write(message); }
  catch { result = { error: 'review_output_write_failed' }; }
  process.send(result, () => { if (process.connected) process.disconnect(); });
});
