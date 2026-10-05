import { mkdirSync, lstatSync, chmodSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultProfile = join(homedir(), '.chatgpt-relay');

export function prepareProfile(path) {
  const profile = resolve(path);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const stat = lstatSync(profile);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Profile must be a real directory.');
  chmodSync(profile, 0o700);
  return profile;
}

export function writePrivateJSON(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  let ownedTemporary = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    ownedTemporary = true;
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (exclusive) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    ownedTemporary = false;
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); }
    finally { closeSync(directory); }
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally { if (ownedTemporary) unlinkSync(temporary); }
  }
}
