import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareProfile, writePrivateJSON } from './profile.mjs';
import { selectEffort } from './effort.mjs';
import { Project, projectRoute } from './project.mjs';
import { composeReviewPrompt, encodeReviewPrompt, escapeReviewJSON, isReviewSourcePath } from './review-files.mjs';
import { RelayError, publicError } from './protocol.mjs';
import { reviewInlineCodeContext } from './review-inline-code.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const historyErrorProof = error => error ? { error: 'visible_error', errorHash: digest(error) } : { error };
const protectHistoryErrors = record => record.baselineHistory ? { ...record,
  baselineHistory: record.baselineHistory.map(proof => proof.error && proof.errorHash === undefined
    ? { ...proof, ...historyErrorProof(proof.error) } : proof) } : record;
const historyIds = record => [...record.baselineIds,
  ...(record.userMessageId ? [record.userMessageId] : []), ...(record.responseId ? [record.responseId] : [])];
const historyProof = (messages) => messages.map(({ id, role, text, inlineCode, links, complete, error }) => ({ id, role, textHash: digest(text),
  ...(links?.length ? { formatHash: digest(JSON.stringify({ inlineCode, links })) }
    : inlineCode?.length ? { formatHash: digest(JSON.stringify(inlineCode)) } : {}), complete, ...historyErrorProof(error) }));
const asciiPunctuation = character => {
  const code = character?.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
};

const linkDestination = label => {
  if (!/^https?:\/\//.test(label)) return null;
  try { return new URL(label).href; } catch { return null; }
};

const promptRepresentations = prompt => {
  const unicode = escapeReviewJSON(prompt);
  return [prompt, encodeReviewPrompt(prompt), unicode, encodeReviewPrompt(unicode)];
};

function* literalPrefixes(source, left, rendered, right, to = rendered.length) {
  yield { at: right, lo: left, hi: left };
  while (right < to) {
    let a = left, b = right;
    while (source[a] === '\\') a++;
    while (b < to && rendered[b] === '\\') b++;
    const k = a - left, j = b - right;
    if (j) {
      const lo = left + Math.ceil(j / 2);
      const hi = left + Math.min(k, j);
      if (lo <= hi) yield { at: b, lo, hi };
    }
    if (b === to) return;
    if (j < k || j > 2 * k + Number(asciiPunctuation(source[a])) ||
        source[a] !== rendered[b]) return;
    left = a + 1;
    right = b + 1;
    yield { at: right, lo: left, hi: left };
  }
}

function literalRange(source, left, rendered, from, to) {
  for (const span of literalPrefixes(source, left, rendered, from, to))
    if (span.at === to) return span;
  return null;
}

function textIndex(text, indexOpen = false) {
  const count = new Uint32Array(text.length + 1);
  let slashRuns = 0;
  for (let i = 0; i < text.length; i++) {
    count[i + 1] = count[i] + Number(text[i] !== '\\');
    if (text[i] !== '\\' && text[i - 1] === '\\') slashRuns++;
  }
  const size = count[text.length], chars = text.replaceAll('\\', '');
  const positions = new Uint32Array(size), runs = new Uint32Array(size);
  const realRuns = new Uint32Array(slashRuns), bad = new Uint32Array(size + 1);
  let slashes = 0, token = 0, run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { slashes++; continue; }
    positions[token] = i;
    runs[token] = slashes;
    if (slashes) realRuns[run++] = token;
    bad[token + 1] =
      bad[token] + Number(slashes > Number(asciiPunctuation(text[i])));
    slashes = 0;
    token++;
  }
  let nextOpen;
  if (indexOpen) {
    nextOpen = new Uint32Array(text.length + 1);
    nextOpen[text.length] = text.length;
    for (let i = text.length - 1; i >= 0; i--)
      nextOpen[i] = text[i] === '[' ? i : nextOpen[i + 1];
  }
  return { chars, positions, runs, realRuns, count, bad, nextOpen };
}

function zValues(pattern, text) {
  const split = pattern.length, size = split + 1 + text.length;
  const at = i => i < split ? pattern.charCodeAt(i)
    : i === split ? -1 : text.charCodeAt(i - split - 1);
  const z = new Uint32Array(size);
  for (let i = 1, l = 0, r = 0; i < size; i++) {
    if (i < r) z[i] = Math.min(r - i, z[i - l]);
    while (i + z[i] < size && at(z[i]) === at(i + z[i])) z[i]++;
    if (i + z[i] > r) { l = i; r = i + z[i]; }
  }
  return z;
}

function lowerBound(values, target) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hrefSourceEnd(source, start, range, href) {
  const first = linkDestination(source.slice(start, range.lo));
  if (first === null) return null;
  if (range.lo === range.hi) return first === href ? range.lo : null;
  const end = range.lo + href.length - first.length;
  if (end < range.lo || end > range.hi) return null;
  const destination = end === range.lo
    ? first : linkDestination(source.slice(start, end));
  return destination === href ? end : null;
}

function indexedDestination(
  source, rendered, si, ri, start, candidate, from, to, z, zBase, textBase
) {
  const a = si.count[start], len = si.count[candidate.lo] - a;
  const b = ri.count[from], entry = zBase + b - textBase;
  if (entry >= z.length || z[entry] < len || ri.positions[b] !== from)
    return null;

  let proof;
  const validEscapes = () => {
    if (proof !== undefined) return proof;
    let bad = ri.bad[b + len] - ri.bad[b];
    for (let i = lowerBound(si.realRuns, a + 1); i < si.realRuns.length; i++) {
      const token = si.realRuns[i];
      if (token >= a + len) break;
      const target = b + token - a, k = si.runs[token], j = ri.runs[target];
      bad -= Number(j > Number(asciiPunctuation(si.chars[token])));
      if (j < k || j > 2 * k + Number(asciiPunctuation(si.chars[token])))
        return proof = false;
    }
    return proof = bad === 0;
  };

  const trailing = to - (ri.positions[b + len - 1] + 1);
  if (source[candidate.lo - 1] !== '\\')
    return trailing === 0 ? { ...candidate, validEscapes } : null;
  let base = candidate.lo;
  while (source[base - 1] === '\\') base--;
  const lo = Math.max(candidate.lo, base + Math.ceil(trailing / 2));
  const hi = Math.min(candidate.hi, base + trailing);
  return lo <= hi ? { lo, hi, validEscapes } : null;
}

function matchesRenderedText(
  source, rendered, inlineCode = [], links = [], codeAt, sourceOffset = 0
) {
  if (inlineCode.some((span, i) =>
    !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
    span.start < (i ? inlineCode[i - 1].end : 0) ||
    span.end < span.start || span.end > rendered.length)) return false;
  if (links.some((span, i) =>
    !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
    typeof span.href !== 'string' ||
    span.start < (i ? links[i - 1].end : 0) ||
    span.end <= span.start || span.end > rendered.length)) return false;

  let si, ri;
  function* edges(state) {
    let [left, right, ci, li] = state;
    while (left < source.length || right < rendered.length) {
      const code = inlineCode[ci], link = links[li];
      if (code?.start === right && source[left] !== '`') { ci++; continue; }
      if (link?.start < right || code?.start < right) return;

      if (link?.start === right &&
          !(code?.start === right && source[left] === '`')) {
        const range = literalRange(source, left, rendered, right, link.end);
        if (!range) return;
        const end = hrefSourceEnd(source, left, range, link.href);
        if (end !== null) yield { state: [end, link.end, ci, li + 1] };
        return;
      }

      if (code?.start === right) {
        const original = typeof codeAt === 'function' &&
          codeAt(left - sourceOffset);
        if (!original) return;
        const start = original.contentStart + sourceOffset;
        const end = original.contentEnd + sourceOffset;
        let literal = '';
        for (let p = start; p < end; p++) {
          const c = source[p];
          if (c === '\r' && source[p + 1] === '\n') p++;
          literal += c === '\r' || c === '\n' ? ' ' : c;
        }
        if (literal.startsWith(' ') && literal.endsWith(' ') &&
            /[^ ]/.test(literal)) literal = literal.slice(1, -1);
        if (rendered.slice(code.start, code.end) !== literal) return;
        while (links[li]?.start < code.end) {
          const span = links[li];
          if (span.start < code.start || span.end > code.end ||
              linkDestination(literal.slice(
                span.start - code.start, span.end - code.start
              )) !== span.href) return;
          li++;
        }
        yield { state: [original.end + sourceOffset, code.end, ci + 1, li] };
        return;
      }

      if (rendered[right] === '[' &&
          (source.startsWith('https://', left) ||
           source.startsWith('http://', left))) {
        si ??= textIndex(source);
        ri ??= textIndex(rendered, true);
        let last;
        for (const span of literalPrefixes(source, left, rendered, right + 1))
          if (rendered.startsWith('](', span.at)) last = span;
        if (!last) return;

        const a = si.count[left], textBase = ri.count[right];
        const len = si.count[last.lo] - a;
        const z = zValues(
          si.chars.slice(a, a + len),
          ri.chars.slice(textBase, textBase + 2 * len + 4)
        );

        for (const candidate of literalPrefixes(
          source, left, rendered, right + 1
        )) {
          if (!rendered.startsWith('](', candidate.at)) continue;
          const size = si.count[candidate.lo] - a;
          const from = candidate.at + 2, token = ri.count[from] + size;
          const to = token < ri.positions.length
            ? ri.positions[token] : undefined;
          if (to === undefined || rendered[to] !== ')') continue;
          const after = to + 1;
          if (ci === inlineCode.length &&
              ri.nextOpen[after] === rendered.length &&
              si.chars.length - si.count[candidate.lo] !==
                ri.chars.length - ri.count[after]) continue;

          const range = indexedDestination(
            source, rendered, si, ri, left, candidate,
            from, to, z, len + 1, textBase
          );
          if (!range) continue;
          for (let end = range.lo; end <= range.hi; end++)
            yield {
              state: [end, after, ci, li],
              check: () => range.validEscapes() &&
                linkDestination(source.slice(left, end)) !== null,
            };
        }
        return;
      }

      let a = left, b = right;
      while (source[a] === '\\') a++;
      while (rendered[b] === '\\' &&
             b !== code?.start && b !== link?.start) b++;
      const k = a - left, j = b - right;
      if (b === link?.start && j) {
        const lo = left + Math.ceil(j / 2);
        const hi = left + Math.min(k, j);
        for (let end = lo; end <= hi; end++)
          yield { state: [end, b, ci, li] };
        return;
      }
      if (j < k || j > 2 * k + Number(asciiPunctuation(source[a]))) return;
      if (code?.start === b) {
        yield { state: [a, b, ci, li] };
        return;
      }
      if (a === source.length && b === rendered.length) {
        yield { complete: ci === inlineCode.length && li === links.length };
        return;
      }
      if (source[a] !== rendered[b]) return;
      left = a + 1;
      right = b + 1;
    }
    yield { complete: ci === inlineCode.length && li === links.length };
  }

  const key = state => state.join(',');
  const memo = new Map(), initial = [0, 0, 0, 0];
  const stack = [{ key: key(initial), iter: edges(initial) }];
  while (stack.length) {
    const frame = stack.at(-1);
    let edge = frame.pending;
    if (edge) {
      frame.pending = undefined;
      if (memo.get(key(edge.state)) &&
          (edge.check === undefined || edge.check())) {
        memo.set(frame.key, true);
        stack.pop();
        continue;
      }
    }
    const next = frame.iter.next();
    if (next.done) {
      memo.set(frame.key, false);
      stack.pop();
      continue;
    }
    edge = next.value;
    if (edge.complete) {
      memo.set(frame.key, true);
      stack.pop();
      continue;
    }
    if (!edge.state) continue;
    const childKey = key(edge.state);
    frame.pending = edge;
    if (!memo.has(childKey))
      stack.push({ key: childKey, iter: edges(edge.state) });
  }
  return memo.get(key(initial)) === true;
}

const requestMessages = (record, messages) => messages.filter(message => message.role === 'user' &&
  !record.baselineIds.includes(message.id) && (message.id === record.userMessageId ||
    matchesRenderedText(`Review request UUID: ${record.id}`, message.text.split('\n', 1)[0])));

function assertRequestContent(record, message) {
  let inlineContext;
  const codeAt = offset => (inlineContext ??= reviewInlineCodeContext(record.prompt)).get(offset);
  const payloadStart = record.prompt.indexOf('\n{"id":');
  if (!promptRepresentations(record.prompt).some((prompt, index) => matchesRenderedText(prompt, message.text,
    message.inlineCode, message.links, index < 2 ? codeAt : undefined,
    index === 1 ? prompt.indexOf('\n{"id":') - payloadStart : 0))) {
    throw new RelayError('review_content_mismatch', 'The identified request body differs from the verified input beyond supported display escaping.');
  }
}

const sameConversation = (left, right) => {
  if (!left || !right) return false;
  const a = projectRoute(left), b = projectRoute(right);
  return a && b && !a.home && !b.home && a.id === b.id && a.origin === b.origin &&
    new URL(left).pathname.split('/c/')[1]?.replace(/\/$/, '') === new URL(right).pathname.split('/c/')[1]?.replace(/\/$/, '');
};

const temporaryConversation = value => Boolean(projectRoute(value)?.home === false &&
  /^local-chatgpt(?::|%3A)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    new URL(value).pathname.split('/c/')[1]?.replace(/\/$/, '')));

const canonicalizesConversation = (left, right) => {
  const before = projectRoute(left), after = projectRoute(right);
  return temporaryConversation(left) && after?.home === false && !temporaryConversation(right) &&
    before.id === after.id && before.origin === after.origin;
};

export class Reviews {
  constructor(profile, browser) {
    this.directory = prepareProfile(join(profile, 'reviews'));
    this.browser = browser;
    this.project = new Project(profile, browser);
  }

  get(id) {
    try { return protectHistoryErrors(JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') throw new RelayError('review_missing', 'No review is recorded for this ID.', 404);
      throw error;
    }
  }

  save(record, update, exclusive = false) {
    const next = protectHistoryErrors({ ...record, ...update, updatedAt: new Date().toISOString() });
    writePrivateJSON(join(this.directory, `${record.id}.json`), next, exclusive);
    return next;
  }

  clearCompletedError(record) {
    return record.state === 'completed' && record.error !== undefined ? this.save(record, { error: undefined }) : record;
  }

  prepare({ reviewId, question, files, effort, part, continueFrom }) {
    const paths = new Set();
    for (const file of files) {
      if (paths.has(file.path) || !isReviewSourcePath(file.path)) {
        throw new RelayError('invalid_source_path', 'Source paths must be unique relative file paths.', 400);
      }
      paths.add(file.path);
      if (file.sha256 !== digest(file.content) || file.bytes !== Buffer.byteLength(file.content)) {
        throw new RelayError('source_mismatch', 'Source content differs from its byte count or SHA-256.', 400);
      }
    }
    const prompt = composeReviewPrompt({ id: reviewId, question, files, part, continueFrom });
    const hash = digest(prompt);
    let previous;
    try { previous = this.get(reviewId); }
    catch (error) { if (error.code !== 'review_missing') throw error; }
    if (previous) {
      if (previous.promptHash !== hash || previous.effort !== effort) throw new RelayError('review_conflict', 'Review ID already contains different input.');
      return this.clearCompletedError(previous);
    }
    this.previous({ id: reviewId, part, continueFrom, sources: files });
    return this.save({ id: reviewId, ...(part ? { part } : {}), ...(continueFrom ? { continueFrom } : {}), state: 'prepared', prompt, promptHash: hash, ...(effort === undefined ? {} : { effort }),
      sources: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      createdAt: new Date().toISOString() }, {}, true);
  }

  previous(record) {
    if (!record.continueFrom) return null;
    const link = record.continueFrom;
    if (link.reviewId === record.id) throw new RelayError('continuation_mismatch', 'A review cannot continue itself.');
    const previous = this.get(link.reviewId);
    if (previous.continuedBy && previous.continuedBy !== record.id) {
      throw new RelayError('continuation_used', 'This previous request already has a recorded continuation. Collect that request instead of resending.');
    }
    if (previous.promptHash !== link.promptHash || previous.effort !== link.effort ||
        (previous.state === 'completed' ? previous.answerHash !== link.answerHash : link.answerHash !== undefined)) {
      throw new RelayError('continuation_mismatch', 'Previous input or answer differs from the continuation checkpoint.');
    }
    if (!['completed', 'submitted', 'uncertain', 'send_attempted'].includes(previous.state)) {
      throw new RelayError('continuation_not_ready', 'The previous request has no recorded send attempt.');
    }
    if (record.part) {
      if (!previous.part || record.part.total !== previous.part.total) {
        throw new RelayError('part_sequence', 'Continue the same multipart review with its original total.');
      }
      if (previous.state === 'completed') {
        if (record.part.index !== previous.part.index + 1) throw new RelayError('part_sequence', 'Continue the immediately preceding part.');
      } else {
        if (record.part.index !== previous.part.index) throw new RelayError('continuation_not_ready', 'Recover this part receipt before sending the next part.');
        if (record.sources.length !== 0) throw new RelayError('part_recovery_material', 'Receipt recovery must not resend source files. Use the existing materials and a recovery question.');
      }
    } else if (previous.part && previous.part.index < previous.part.total) {
      throw new RelayError('part_sequence', 'This multipart review still requires its next numbered part.');
    }
    return previous;
  }

  assertBaseline(record, messages) {
    const actual = record.baselineHistory ? historyProof(messages) : messages.map(message => message.id);
    const expected = record.baselineHistory || record.baselineIds;
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    const changed = () => {
      throw new RelayError('conversation_changed', 'Earlier conversation messages changed or are missing.');
    };
    if (!record.baselineHistory || actual.length !== expected.length) changed();
    const ancestors = new Map();
    let ancestor = record;
    while (ancestor.continueFrom) {
      ancestor = this.get(ancestor.continueFrom.reviewId);
      if (ancestor.userMessageId) ancestors.set(ancestor.userMessageId, ancestor);
    }
    for (let index = 0; index < actual.length; index++) {
      const { textHash: actualHash, formatHash: actualFormat, ...actualIdentity } = actual[index];
      const { textHash: expectedHash, formatHash: expectedFormat, ...expectedIdentity } = expected[index];
      if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) changed();
      if (actualHash === expectedHash && actualFormat === expectedFormat) continue;
      const previous = ancestors.get(actualIdentity.id);
      if (actualIdentity.role !== 'user' || !previous) changed();
      assertRequestContent(previous, messages[index]);
    }
  }

  assertPrevious(previous, view) {
    if (projectRoute(previous.conversationURL)?.home === false && !sameConversation(previous.conversationURL, view.url) &&
        !(previous.userMessageId && canonicalizesConversation(previous.conversationURL, view.url))) {
      throw new RelayError('conversation_changed', 'The browser is not in the recorded conversation.');
    }
    const matches = requestMessages(previous, view.messages);
    if (matches.length !== 1 || (previous.userMessageId && matches[0].id !== previous.userMessageId)) {
      throw new RelayError('conversation_changed', 'The previous request must appear exactly once with its recorded identity.');
    }
    const user = matches[0], position = view.messages.indexOf(user);
    assertRequestContent(previous, user);
    if (user.error) throw new RelayError('response_failed', 'The previous request has a visible error; its delivery cannot be confirmed.');
    this.assertBaseline(previous, view.messages.slice(0, position));
    const following = view.messages.slice(position + 1);
    if (following.length > 1 || following.some(message => message.role !== 'assistant')) {
      throw new RelayError('conversation_changed', 'Another turn follows the previous review.');
    }
    const answer = following[0];
    if (previous.state === 'completed' && (!answer || !answer.complete || answer.error || answer.id !== previous.responseId || digest(answer.text) !== previous.answerHash)) {
      throw new RelayError('conversation_changed', 'The previous answer differs from the collected result.');
    }
    if (view.busy) throw new RelayError('generation_active', 'The previous response is still generating.');
    return { userMessageId: user.id, conversationURL: view.url };
  }

  async openPrevious(previous, project, signal, deadlineAt) {
    if (!previous.project || previous.project.id !== project.id || previous.project.origin !== project.origin) {
      throw new RelayError('project_changed', 'Continuation belongs to a different bound project.');
    }
    let view = await this.browser.reviewView(signal);
    if (projectRoute(previous.conversationURL)?.home === false && !sameConversation(previous.conversationURL, view.url) &&
        !(previous.userMessageId && canonicalizesConversation(previous.conversationURL, view.url))) {
      this.assertReady(view);
      this.project.assertURL(project, previous.conversationURL);
      await this.browser.navigateReview(previous.conversationURL, view, signal, deadlineAt);
      while (true) {
        view = await this.browser.reviewView(signal);
        this.project.assertURL(project, view.url);
        if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
        if ((!sameConversation(previous.conversationURL, view.url) &&
            !(previous.userMessageId && canonicalizesConversation(previous.conversationURL, view.url))) ||
            (previous.userMessageId && requestMessages(previous, view.messages).some(message => message.id !== previous.userMessageId))) {
          this.identifyRequest(previous, view);
        }
        if (view.composer && (view.historyScrollable || historyIds(previous).every(id => view.messages.some(message => message.id === id)))) break;
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new RelayError('continuation_not_ready', 'The recorded conversation did not finish loading.');
        await this.browser.waitReviewChange(view, remaining, signal);
      }
    }
    this.project.assertURL(project, view.url);
    if (projectRoute(view.url)?.home) throw new RelayError('conversation_changed', 'Continuation requires the previous conversation, not a project home.');
    view = await this.browser.reviewView(signal, historyIds(previous), deadlineAt);
    while (true) {
      this.assertReady(view);
      const binding = this.assertPrevious(previous, view);
      if (!previous.userMessageId || previous.conversationURL !== binding.conversationURL) previous = this.save(previous, binding);
      if (view.stableForMs >= 600) return view;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new RelayError('continuation_not_ready', 'Previous response did not become stable.');
      await this.browser.waitReviewChange(view, Math.min(remaining, 600 - view.stableForMs), signal);
      view = await this.browser.reviewView(signal, historyIds(previous), deadlineAt);
    }
  }

  async submit(id, documentId, signal, deadlineAt) {
    let record = this.get(id);
    const knownUnsent = record.state === 'uncertain' && record.error?.code === 'target_obscured' && !record.sendAttemptedAt;
    if (record.sendAttemptedAt || (!['prepared', 'preparing', 'failed'].includes(record.state) && !knownUnsent)) return this.clearCompletedError(record);
    record = this.save(record, { phase: 'checking_context', error: undefined });
    const phase = (value) => {
      this.browser.assertActive(signal);
      record = this.save(record, { phase: value });
    };
    const fail = (error) => {
      const failure = { phase: record.phase, at: new Date().toISOString(), error: publicError(error) };
      const state = record.sendAttemptedAt ? 'uncertain' : record.state === 'prepared' && failure.error.code !== 'command_timeout' ? 'prepared' : 'failed';
      record = this.save(record, { state, error: failure.error, lastFailure: failure });
    };
    const abort = () => fail(new RelayError('command_timeout', 'Execution deadline expired during review submission.', 504));
    let effortToken;
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.browser.assertActive(signal);
      this.browser.assertDocument(documentId);
      const project = this.project.require();
      if (record.project && (record.project.id !== project.id || record.project.origin !== project.origin)) {
        throw new RelayError('project_changed', 'Resume requires the originally recorded project binding.');
      }
      let before = await this.browser.reviewView(signal);
      const encodedPrompt = encodeReviewPrompt(escapeReviewJSON(record.prompt));
      const resumeDraft = (['preparing', 'failed'].includes(record.state) || knownUnsent) &&
        promptRepresentations(record.prompt).includes(before.draft);
      const submittedText = resumeDraft ? before.draft : encodedPrompt;
      this.assertReady(before, resumeDraft ? submittedText : '');
      const previous = this.previous(record);
      if (resumeDraft) {
        if (record.startURL !== before.url && !sameConversation(record.startURL, before.url)) {
          throw new RelayError('conversation_changed', 'The prepared draft is outside its recorded conversation.');
        }
        before = await this.browser.reviewView(signal, record.baselineIds, deadlineAt);
        this.assertBaseline(record, before.messages);
        if (previous) this.assertPrevious(previous, before);
      } else if (previous) {
        phase('opening_previous');
        before = await this.openPrevious(previous, project, signal, deadlineAt);
        documentId = this.browser.status().documentId;
      } else {
        phase('opening_project');
        const opened = await this.project.open(signal, deadlineAt);
        documentId = opened.documentId;
        before = await this.browser.reviewView(signal);
      }
      phase('checking_composer');
      this.assertReady(before, resumeDraft ? submittedText : '');
      this.project.assertURL(project, before.url);
      this.browser.assertDocument(documentId);
      const expectedHistory = before.inputHistory;
      const baselineHistory = historyProof(before.messages);
      record = this.save(record, { state: 'preparing', error: undefined, project, origin: new URL(before.url).origin,
        startURL: before.url, baselineIds: baselineHistory.map((message) => message.id), baselineHistory });
      if (record.effort !== undefined) {
        const selection = await selectEffort(this.browser, record.effort, before, documentId, signal, deadlineAt, expectedHistory, phase);
        effortToken = selection.token;
        this.browser.assertActive(signal);
        record = this.save(record, { selectedEffort: selection.selected });
      }
      if (!resumeDraft) {
        phase('filling');
        await this.browser.execute({ effortToken, expectedHistory, action: 'fill', documentId, target: before.composer, text: submittedText, expectedURL: before.url,
          expectedText: { target: before.composer, text: '' } }, signal, deadlineAt);
      }
      phase('waiting_to_send');
      let ready;
      while (true) {
        ready = await this.browser.reviewView(signal, record.baselineIds, deadlineAt);
        this.assertReady(ready, submittedText);
        this.project.assertURL(project, ready.url);
        this.browser.assertDocument(documentId);
        this.assertBaseline(record, ready.messages);
        if (ready.send && ready.sendEnabled && ready.stableForMs >= 600) break;
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new RelayError('command_timeout', 'Send control did not become ready before the deadline.', 504);
        await this.browser.waitReviewChange(ready, ready.send && ready.sendEnabled ? Math.min(remaining, Math.max(1, 600 - ready.stableForMs)) : remaining, signal);
      }
      this.browser.assertDocument(documentId);
      phase('sending');
      await this.browser.execute({ effortToken, expectedHistory: ready.inputHistory, action: 'click', documentId, target: ready.send, expectedURL: ready.url,
        expectedText: { target: ready.composer, text: submittedText } }, signal, deadlineAt, () => {
        if (previous) this.save(this.get(previous.id), { continuedBy: record.id });
        record = this.save(record, { state: 'send_attempted', sendAttemptedAt: new Date().toISOString() });
      });
      this.browser.assertActive(signal);
      phase('locating_request');
      while (true) {
        const view = await this.browser.reviewView(signal);
        const found = this.identifyRequest(record, view);
        if (found) {
          record = this.save(record, found.binding);
          if (!projectRoute(view.url)?.home && !temporaryConversation(view.url)) return this.save(record, { state: 'submitted' });
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new RelayError('command_timeout', 'The sent request identity did not become observable before the deadline.', 504);
        await this.browser.waitReviewChange(view, remaining, signal);
      }
    } catch (error) {
      if (!signal?.aborted || record.error?.code !== 'command_timeout') fail(error);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (effortToken) await this.browser.releaseEffort(effortToken);
    }
  }

  assertReady(view, prompt = '') {
    if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
    if (!view.composer) throw new RelayError('unsupported_chatgpt_ui', 'Composer lacks a supported unique stable identifier.');
    if (view.busy) throw new RelayError('generation_active', 'The current conversation is still generating.');
    if (view.draft !== prompt) throw new RelayError('draft_conflict', 'Composer content differs from the expected draft; it will not be overwritten or sent.');
    if (view.attachments) throw new RelayError('attachments_present', 'The composer contains existing attachments.');
  }

  identifyRequest(record, view) {
    if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
    if (record.project) this.project.assertURL(record.project, view.url);
    const canonicalizing = Boolean(record.userMessageId) && canonicalizesConversation(record.conversationURL, view.url);
    if (projectRoute(record.conversationURL)?.home === false && !sameConversation(record.conversationURL, view.url) && !canonicalizing) {
      throw new RelayError('conversation_changed', 'Browser left the recorded review conversation.');
    }
    if (new URL(view.url).origin !== record.origin) throw new RelayError('conversation_changed', 'Browser left the review origin.');
    const matches = requestMessages(record, view.messages);
    if (matches.length > 1) throw new RelayError('ambiguous_request', 'The same review identity appears more than once.');
    if (!matches.length) {
      if (record.userMessageId) throw new RelayError('conversation_changed', 'Recorded review message is no longer present.');
      return null;
    }
    const user = matches[0];
    if (record.userMessageId && user.id !== record.userMessageId) throw new RelayError('conversation_changed', 'Recorded user message was replaced.');
    assertRequestContent(record, user);
    if (canonicalizing && !view.busy) this.assertBaseline(record, view.messages.slice(0, view.messages.indexOf(user)));
    return { user, binding: { conversationURL: view.url, userMessageId: user.id } };
  }

  requestBinding(record, view) {
    const found = this.identifyRequest(record, view);
    if (found) this.assertBaseline(record, view.messages.slice(0, view.messages.indexOf(found.user)));
    return found;
  }

  observation(record, view) {
    const found = this.requestBinding(record, view);
    if (!found) return { state: 'request_unobserved' };
    const { user, binding } = found;
    const following = view.messages.slice(view.messages.indexOf(user) + 1);
    if (following.some((message) => message.role === 'user')) throw new RelayError('conversation_changed', 'Another user message follows this review.');
    const answers = following.filter((message) => message.role === 'assistant');
    if (answers.length > 1) throw new RelayError('ambiguous_response', 'Multiple assistant messages follow the review.');
    const answer = answers[0];
    if (user.error) throw new RelayError('response_failed', 'The review request has a visible error; its delivery cannot be confirmed.');
    if (following.some(message => message.error)) throw new RelayError('response_failed', 'The assistant response has a visible error; review completion cannot be confirmed.');
    if (!answer || view.busy || !answer.complete) return { ...binding, state: 'generating' };
    if (answer.text.trimEnd().split('\n').at(-1) !== `END-OF-REVIEW:${record.id}`) {
      return { ...binding, state: 'response_incomplete', responseId: answer.id };
    }
    if (record.part && record.part.index < record.part.total && !answer.text.split('\n').includes(`PART-RECEIVED:${record.part.index}/${record.part.total}:${record.id}`)) {
      return { ...binding, state: 'response_incomplete', responseId: answer.id };
    }
    return { ...binding, state: 'candidate', responseId: answer.id, answer: answer.text };
  }

  async collect(id, waitMs, signal, deadlineAt = Date.now() + 30000) {
    let record = this.get(id);
    if (record.state === 'completed') return this.clearCompletedError(record);
    if (!['submitted', 'uncertain', 'send_attempted'].includes(record.state)) {
      throw new RelayError('review_not_submitted', 'This review has no recorded send attempt.');
    }
    const until = Date.now() + waitMs;
    this.browser.assertActive(signal);
    let view = await this.browser.reviewView(signal);
    const currentRequest = requestMessages(record, view.messages);
    const canonicalizing = record.userMessageId && canonicalizesConversation(record.conversationURL, view.url) &&
      currentRequest.some(message => message.id === record.userMessageId);
    if (projectRoute(record.conversationURL)?.home === false && !sameConversation(record.conversationURL, view.url) &&
        !canonicalizing) {
      if (currentRequest.length) this.identifyRequest(record, view);
      const project = this.project.require();
      if (!record.project || record.project.id !== project.id || record.project.origin !== project.origin) {
        throw new RelayError('project_changed', 'Collection belongs to a different bound project.');
      }
      this.project.assertURL(project, record.conversationURL);
      this.assertReady(view);
      await this.browser.navigateReview(record.conversationURL, view, signal, deadlineAt);
      while (true) {
        view = await this.browser.reviewView(signal);
        this.project.assertURL(project, view.url);
        if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
        if ((!sameConversation(record.conversationURL, view.url) &&
            !(record.userMessageId && canonicalizesConversation(record.conversationURL, view.url))) ||
            (record.userMessageId && requestMessages(record, view.messages).some(message => message.id !== record.userMessageId))) {
          this.identifyRequest(record, view);
        }
        if (view.composer && (view.historyScrollable || historyIds(record).every(id => view.messages.some(message => message.id === id)))) {
          view = await this.browser.reviewView(signal, historyIds(record), deadlineAt);
          break;
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new RelayError('review_not_ready', 'The recorded conversation did not finish loading.');
        await this.browser.waitReviewChange(view, remaining, signal);
      }
    }
    while (true) {
      this.browser.assertActive(signal);
      let observed;
      if (view.busy) {
        const found = this.identifyRequest(record, view);
        observed = { ...found?.binding, state: 'generating' };
      } else {
        view = await this.browser.reviewView(signal, historyIds(record), deadlineAt);
        observed = this.observation(record, view);
      }
      if (observed.userMessageId && (!record.userMessageId || record.conversationURL !== observed.conversationURL)) {
        record = this.save(record, { userMessageId: observed.userMessageId, conversationURL: observed.conversationURL });
      }
      const candidate = observed.state === 'candidate';
      if (candidate && view.stableForMs >= 600) {
        return this.save(record, { state: 'completed', error: undefined, answer: observed.answer, responseId: observed.responseId,
          answerHash: digest(observed.answer), completedAt: new Date().toISOString() });
      }
      const remaining = until - Date.now();
      if (remaining <= 0) return { ...record, observation: { ...observed, answer: undefined,
        retryAfterMs: candidate ? Math.max(1, Math.ceil(600 - view.stableForMs)) : 30000 } };
      await this.browser.waitReviewChange(view, Math.min(remaining, candidate ? 600 - view.stableForMs : remaining), signal);
      view = await this.browser.reviewView(signal);
    }
  }
}
