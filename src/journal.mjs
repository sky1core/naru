import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RelayError } from './protocol.mjs';
import { prepareProfile, writePrivateJSON } from './profile.mjs';

export class Journal {
  constructor(profile) {
    this.directory = prepareProfile(join(profile, 'requests'));
  }

  get(id) {
    try {
      return JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  begin(id, command) {
    const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const previous = this.get(id);
    if (previous) {
      if (previous.digest !== digest) throw new RelayError('request_conflict', 'Request ID was used for a different command.');
      return { fresh: false, record: previous };
    }
    const record = { id, digest, state: 'started', startedAt: new Date().toISOString() };
    writePrivateJSON(join(this.directory, `${id}.json`), record, true);
    return { fresh: true, record };
  }

  finish(record, outcome) {
    const final = { ...record, ...outcome, finishedAt: new Date().toISOString() };
    writePrivateJSON(join(this.directory, `${record.id}.json`), final);
    return final;
  }
}
