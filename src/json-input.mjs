import { jsonParser } from 'stream-json/core/parser.js';
import { none, getManyValues } from 'stream-chain/core';
import { commandSchema, maxRequestBytes, RelayError } from './protocol.mjs';

const oversized = Symbol('oversized JSON value');
const invalid = Symbol('invalid JSON field');
const fields = {
  request: { id: 'fixedString', deadlineMs: 'number', command: 'command' },
  checkpoint: { version: 'number', profile: 'profile', prepareRequestId: 'fixedString', reviewId: 'fixedString', promptHash: 'fixedString', command: 'command' },
  command: { action: 'fixedString', url: 'string', documentId: 'fixedString', target: 'target', text: 'string', key: 'fixedString', state: 'fixedString',
    timeoutMs: 'number', reviewId: 'fixedString', part: 'part', continueFrom: 'continuation', effort: 'fixedString', question: 'question', files: 'files', waitMs: 'number' },
  target: { attribute: 'fixedString', value: 'string', scope: 'scope' },
  scope: { attribute: 'fixedString', value: 'string', scope: 'attributeTarget' },
  attributeTarget: { attribute: 'fixedString', value: 'string' },
  part: { index: 'number', total: 'number' },
  continuation: { effort: 'fixedString', reviewId: 'fixedString', promptHash: 'fixedString', answerHash: 'fixedString' },
  file: { path: 'string', content: 'string', sha256: 'fixedString', bytes: 'number' },
};
const fileSchema = commandSchema.options.find(schema => schema.shape.action.value === 'review.prepare').shape.files.element;
const maxFieldNameLength = Math.max(...Object.values(fields).flatMap(value => Object.keys(value).map(key => key.length)));
const node = (value, bytes) => ({ value, bytes });
const size = value => Buffer.byteLength(JSON.stringify(value));
const capped = bytes => Math.min(bytes, maxRequestBytes + 1);

function onlyOversizedIssues(value, result) {
  if (result.success) return false;
  return result.error.issues.length > 0 && result.error.issues.every(issue => {
    let entry = value;
    for (const key of issue.path) entry = entry?.[key];
    return entry === oversized && issue.code === 'invalid_type';
  });
}

export function assertJSONInputSize(value, parsed) {
  if (onlyOversizedIssues(value, parsed)) {
    throw new RelayError('body_too_large', 'Input exceeds the 8 MiB API request limit. No source was truncated or sent.', 413);
  }
}

class JSONNumber {
  constructor(fileBytes) {
    this.limit = fileBytes + 2048n;
    this.negative = false;
    this.fraction = false;
    this.exponent = false;
    this.exponentNegative = false;
    this.exponentValue = 0n;
    this.digits = 0n;
    this.integerDigits = 0n;
    this.first = undefined;
    this.prefix = '';
    this.sticky = false;
  }

  write(chunk) {
    for (const char of chunk) {
      if (char === 'e' || char === 'E') { this.exponent = true; continue; }
      if (char === '-') {
        if (this.exponent) this.exponentNegative = true;
        else this.negative = true;
        continue;
      }
      if (char === '+') continue;
      if (char === '.') { this.fraction = true; continue; }
      if (this.exponent) {
        this.exponentValue = this.exponentValue * 10n + BigInt(char);
        if (this.exponentValue > this.limit) this.exponentValue = this.limit;
        continue;
      }
      if (!this.fraction) this.integerDigits++;
      if (this.first === undefined && char !== '0') this.first = this.digits;
      this.digits++;
      if (this.first !== undefined) {
        if (this.prefix.length < 800) this.prefix += char;
        else if (char !== '0') this.sticky = true;
      }
    }
  }

  value() {
    if (this.first === undefined) return this.negative ? -0 : 0;
    const exponent = (this.exponentNegative ? -this.exponentValue : this.exponentValue) + this.integerDigits - this.first - 1n;
    const digits = this.prefix + (this.sticky ? '1' : '');
    return JSON.parse(`${this.negative ? '-' : ''}${digits[0]}.${digits.slice(1) || '0'}e${exponent}`);
  }
}

export function createJSONInput(kind, fileBytes, profile) {
  if (!['request', 'command', 'checkpoint'].includes(kind)) throw new TypeError('Unknown JSON input kind.');
  const parse = jsonParser({ packKeys: false, packStrings: false, packNumbers: false });
  const stack = [];
  let root, scalar, key, skipped = 0, discarded;
  const context = () => {
    const parent = stack.at(-1);
    if (!parent) return kind;
    if (parent.role === 'files') return 'file';
    return parent.key === undefined ? undefined : fields[parent.role][parent.key];
  };
  const accept = entry => {
    const parent = stack.at(-1);
    if (!parent) { root = entry; return; }
    if (parent.role === 'files') {
      const parsed = fileSchema.safeParse(entry.value);
      if (!parsed.success && !onlyOversizedIssues(entry.value, parsed)) parent.invalid = true;
      parent.bytes = capped(parent.bytes + entry.bytes + (parent.count++ ? 1 : 0));
      if (parent.invalid || parent.bytes > maxRequestBytes) parent.items = undefined;
      else parent.items.push(entry.value);
    } else if (parent.key !== undefined) {
      parent.slots.set(parent.key, entry);
    } else if (parent.role !== 'checkpoint') {
      parent.unknown = true;
    }
  };
  const consume = token => {
    const { name, value } = token;
    if (skipped) {
      if (name === 'startObject' || name === 'startArray') skipped++;
      if (name === 'endObject' || name === 'endArray') {
        if (--skipped === 0) accept(discarded);
      }
      return;
    }
    if (name === 'startKey') { key = ''; return; }
    if (name === 'endKey') {
      const parent = stack.at(-1);
      parent.key = key !== undefined && Object.hasOwn(fields[parent.role], key) ? key : undefined;
      key = undefined;
      return;
    }
    if (name === 'stringChunk' && key === null) return;
    if (name === 'stringChunk' && key !== undefined) {
      key = key.length + value.length <= maxFieldNameLength ? key + value : undefined;
      if (key === undefined) key = null;
      return;
    }
    if (name === 'startObject' || name === 'startArray') {
      const role = context();
      if ((name === 'startObject' && fields[role]) || (name === 'startArray' && role === 'files')) {
        stack.push(role === 'files' ? { role, items: [], bytes: 2, count: 0, invalid: false } : { role, slots: new Map(), unknown: false });
      } else {
        skipped = 1;
        discarded = node(name === 'startObject' ? {} : [], 2);
      }
      return;
    }
    if (name === 'endObject' || name === 'endArray') {
      const frame = stack.pop();
      if (frame.role === 'files') {
        accept(node(frame.items === undefined ? (frame.invalid ? invalid : oversized) : frame.items, frame.bytes));
        return;
      }
      const result = {};
      let bytes = 2;
      for (const [field, entry] of frame.slots) {
        Object.defineProperty(result, field, { value: entry.value, enumerable: true, writable: true, configurable: true });
        bytes = capped(bytes + size(field) + 1 + entry.bytes + (Object.keys(result).length > 1 ? 1 : 0));
      }
      if (frame.unknown) result.__unknownJSONField = null;
      accept(node(result, bytes));
      return;
    }
    if (name === 'startString') {
      const role = context();
      scalar = { role, text: '', length: 0, large: false, nonWhitespace: false, match: role === 'profile' };
      return;
    }
    if (name === 'stringChunk') {
      if (scalar.role === 'profile') {
        scalar.match &&= typeof profile === 'string' && profile.slice(scalar.length, scalar.length + value.length) === value;
        scalar.length += value.length;
      } else if (['string', 'fixedString', 'question'].includes(scalar.role)) {
        if (scalar.role === 'question' && !scalar.nonWhitespace) scalar.nonWhitespace = /\S/.test(value);
        if (!scalar.large) {
          if (scalar.text.length + value.length > maxRequestBytes) { scalar.large = true; scalar.text = ''; }
          else scalar.text += value;
        }
      }
      return;
    }
    if (name === 'endString') {
      let entry;
      if (scalar.role === 'profile') entry = node(scalar.match && scalar.length === profile?.length ? profile : invalid, 0);
      else if (!['string', 'fixedString', 'question'].includes(scalar.role)) entry = node(invalid, 0);
      else {
        const bytes = scalar.large ? maxRequestBytes + 1 : size(scalar.text);
        const invalidString = scalar.role === 'fixedString' || (scalar.role === 'question' && !scalar.nonWhitespace);
        entry = node(bytes > maxRequestBytes ? (invalidString ? invalid : oversized) : scalar.text, capped(bytes));
      }
      scalar = undefined;
      accept(entry);
      return;
    }
    if (name === 'startNumber') { scalar = context() === 'number' ? new JSONNumber(fileBytes) : undefined; return; }
    if (name === 'numberChunk') { scalar?.write(value); return; }
    if (name === 'endNumber') {
      const number = scalar ? scalar.value() : 0;
      scalar = undefined;
      accept(node(number, size(number)));
      return;
    }
    if (name === 'trueValue' || name === 'falseValue' || name === 'nullValue') accept(node(value, size(value)));
  };
  return {
    write(text) {
      const tokens = parse(text);
      if (tokens !== none) for (const token of getManyValues(tokens)) consume(token);
    },
    finish() {
      const tokens = parse(none);
      if (tokens !== none) for (const token of getManyValues(tokens)) consume(token);
      return root.value;
    },
  };
}
