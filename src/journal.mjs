import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RelayError } from './protocol.mjs';
import { prepareProfile, writePrivateJSON } from './profile.mjs';

export class Journal {
  constructor(profile) {
    this.directory = prepareProfile(join(profile, 'requests'));
    this.reviewsDirectory = join(profile, 'reviews');
  }

  get(id) {
    try {
      return this.restore(JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  promptFor(reference, result) {
    const invalid = () => { throw new RelayError('review_reference_invalid', 'Recorded review prompt reference cannot be verified.', 500); };
    if (!reference || !z.uuid().safeParse(reference.reviewId).success || typeof reference.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(reference.hash) || result?.id !== reference.reviewId || result?.promptHash !== reference.hash) invalid();
    let review;
    try { review = JSON.parse(readFileSync(join(this.reviewsDirectory, `${reference.reviewId}.json`), 'utf8')); }
    catch { invalid(); }
    if (review?.id !== reference.reviewId || typeof review.prompt !== 'string' || review.promptHash !== reference.hash ||
        createHash('sha256').update(review.prompt).digest('hex') !== reference.hash) invalid();
    return review.prompt;
  }

  restore(record) {
    if (!Object.hasOwn(record, 'reviewPromptRef')) return record;
    const { reviewPromptRef, ...rest } = record;
    if (Object.hasOwn(record.result || {}, 'prompt')) {
      throw new RelayError('review_reference_invalid', 'Recorded review prompt reference cannot be verified.', 500);
    }
    return { ...rest, result: { ...record.result, prompt: this.promptFor(reviewPromptRef, record.result) } };
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

  finish(record, outcome, { reviewId } = {}) {
    let final = { ...record, ...outcome, finishedAt: new Date().toISOString() };
    if (reviewId !== undefined && Object.hasOwn(outcome.result || {}, 'prompt')) {
      const reference = { reviewId, hash: outcome.result.promptHash };
      const prompt = this.promptFor(reference, outcome.result);
      if (prompt !== outcome.result.prompt) throw new RelayError('review_reference_invalid', 'Review result differs from its recorded prompt.', 500);
      const { prompt: omitted, ...result } = outcome.result;
      final = { ...final, result, reviewPromptRef: reference };
    }
    writePrivateJSON(join(this.directory, `${record.id}.json`), final);
    return this.restore(final);
  }
}
