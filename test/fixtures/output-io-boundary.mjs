import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reviewFiles = new URL('../../src/review-files.mjs', import.meta.url);

export function runOutput(path, text, boundary, directory) {
  return new Promise((resolve, reject) => {
    const driver = spawn(process.execPath, ['--input-type=module', '-e', `
      import { writeReviewOutput } from ${JSON.stringify(reviewFiles.href)};
      process.once('message', async ({ path, text }) => {
        try { process.send({ output: await writeReviewOutput(path, text) }); }
        catch (error) { process.send({ error: { code: error.code, message: error.message } }); }
        process.disconnect();
      });
    `], {
      env: { ...process.env, NODE_OPTIONS: `--import=${import.meta.url}`, OUTPUT_IO_BOUNDARY: boundary, OUTPUT_IO_DIRECTORY: directory },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result, stderr = '';
    driver.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    driver.on('message', message => { result = message; });
    driver.once('error', reject);
    driver.once('close', code => {
      if (code !== 0 || !result) reject(new Error(`Output driver failed (${code}): ${stderr}`));
      else resolve({ ...result, stderr });
    });
    driver.send({ path, text });
  });
}

const isWriter = process.env.OUTPUT_IO_BOUNDARY && (!process.argv[1] || basename(process.argv[1]) === 'output-writer-child.mjs');
if (isWriter) {
  const boundary = process.env.OUTPUT_IO_BOUNDARY;
  const directory = process.env.OUTPUT_IO_DIRECTORY;
  const native = { open: fs.open, link: fs.link, unlink: fs.unlink, fsync: nodeFs.fsync, close: nodeFs.close, spawn: childProcess.spawn };
  let injected = false;
  async function replaceDirectory() {
    injected = true;
    const names = await fs.readdir(directory);
    await fs.rename(directory, join(directory, '..', 'original'));
    await fs.mkdir(directory, { mode: 0o770 });
    const replacementNames = [...new Set([...names, 'answer.txt', 'unrelated.txt'])].sort();
    const originalModes = [];
    for (const name of names) {
      const path = join(directory, '..', 'original', name), metadata = await fs.lstat(path);
      originalModes.push({ name, mode: metadata.mode & 0o777, directory: metadata.isDirectory() });
      if (metadata.isDirectory()) for (const child of await fs.readdir(path)) {
        originalModes.push({ name: `${name}/${child}`, mode: (await fs.lstat(join(path, child))).mode & 0o777, directory: false });
      }
    }
    for (const name of replacementNames) {
      await fs.writeFile(join(directory, name), `OTHER USER DATA:${name}`, { mode: 0o644 });
      await fs.chmod(join(directory, name), 0o644);
    }
    await fs.writeFile(join(directory, '..', 'injected'), JSON.stringify({ boundary, replacementNames, originalModes }));
  }
  const probe = await native.open(fileURLToPath(import.meta.url), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = prototype.sync, writeFile = prototype.writeFile;
  prototype.writeFile = async function (...args) {
    if (boundary === 'write-failure' && (await this.stat()).isFile()) {
      await writeFile.call(this, 'partial');
      throw Object.assign(new Error('Injected I/O failure'), { code: 'EIO' });
    }
    return writeFile.apply(this, args);
  };
  prototype.sync = async function (...args) {
    const metadata = await this.stat();
    if (metadata.isDirectory() && boundary === 'directory-sync-failure') {
      await fs.writeFile(join(directory, '..', 'directory-synced'), 'attempted');
      throw Object.assign(new Error('Injected I/O failure'), { code: 'EIO' });
    }
    if (metadata.isFile() && ['file-sync-failure', 'cleanup'].includes(boundary)) {
      throw Object.assign(new Error('Injected I/O failure'), { code: 'EIO' });
    }
    const result = await sync.apply(this, args);
    if (metadata.isFile()) {
      await fs.writeFile(join(directory, '..', 'file-synced'), 'complete');
      if (!injected && boundary === 'sync') await replaceDirectory();
      if (!injected && boundary === 'sibling') {
        injected = true;
        await fs.writeFile(join(directory, 'unrelated.txt'), 'unrelated data');
      }
    }
    return result;
  };
  fs.link = async (...args) => {
    if (!injected && boundary === 'link') await replaceDirectory();
    return native.link(...args);
  };
  fs.unlink = async (...args) => {
    if (!injected && ['unlink', 'cleanup'].includes(boundary)) await replaceDirectory();
    if (!injected && boundary === 'staging-replacement') {
      injected = true;
      const staging = basename(process.cwd()), path = join(directory, staging);
      await fs.rename(path, `${path}.original`);
      await fs.mkdir(path, { mode: 0o770 });
      await fs.writeFile(join(path, 'answer'), 'OTHER USER DATA', { mode: 0o644 });
      await fs.chmod(join(path, 'answer'), 0o644);
      await fs.writeFile(join(directory, '..', 'replaced-name'), staging);
    }
    return native.unlink(...args);
  };
  nodeFs.fsync = (fd, callback) => {
    if (boundary === 'directory-sync-failure' && nodeFs.fstatSync(fd).isDirectory()) {
      fs.writeFile(join(directory, '..', 'directory-synced'), 'attempted').then(
        () => callback(Object.assign(new Error('Injected I/O failure'), { code: 'EIO' })), callback,
      );
    } else native.fsync(fd, callback);
  };
  childProcess.spawn = (command, args, options) => {
    if (boundary === 'startup' && options?.cwd === directory) {
      nodeFs.renameSync(directory, join(directory, '..', 'original'));
      nodeFs.mkdirSync(directory, { mode: 0o770 });
      nodeFs.writeFileSync(join(directory, 'answer.txt'), 'OTHER USER DATA', { mode: 0o644 });
      nodeFs.chmodSync(join(directory, 'answer.txt'), 0o644);
    }
    return native.spawn(command, args, options);
  };
  nodeFs.close = (fd, callback) => {
    if (boundary === 'published-inode' && nodeFs.fstatSync(fd).isDirectory()) {
      fs.rename('answer.txt', 'original-answer.txt').then(async () => {
        await fs.writeFile('answer.txt', 'FORGED ANSWER', { mode: 0o600 });
        native.close(fd, callback);
      }, callback).catch(callback);
    } else native.close(fd, callback);
  };
  syncBuiltinESMExports();
}
