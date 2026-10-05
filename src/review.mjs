import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareProfile, writePrivateJSON } from './profile.mjs';
import { selectEffort } from './effort.mjs';
import { Project, projectRoute } from './project.mjs';
import { composeReviewPrompt, encodeReviewPrompt, isReviewSourcePath } from './review-files.mjs';
import { RelayError, publicError } from './protocol.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const historyIds = record => [...record.baselineIds,
  ...(record.userMessageId ? [record.userMessageId] : []), ...(record.responseId ? [record.responseId] : [])];
const historyProof = (messages) => messages.map(({ id, role, text, inlineCode, complete, error }) => ({ id, role, textHash: digest(text),
  ...(inlineCode?.length ? { formatHash: digest(JSON.stringify(inlineCode)) } : {}), complete, error }));
const asciiPunctuation = character => {
  const code = character?.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
};

function escapedLiteralEnd(source, rendered, start) {
  let left = 0, right = start;
  while (left < source.length) {
    let sourceSlashes = 0, renderedSlashes = 0;
    while (source[left] === '\\') { left++; sourceSlashes++; }
    while (rendered[right] === '\\') { right++; renderedSlashes++; }
    if (renderedSlashes < sourceSlashes || renderedSlashes > sourceSlashes * 2 + Number(asciiPunctuation(source[left]))) return null;
    if (left === source.length) return right;
    if (source[left] !== rendered[right]) return null;
    left++; right++;
  }
  return right;
}

function matchesRenderedText(source, rendered, inlineCode = []) {
  let left = 0, right = 0, codeIndex = 0;
  if (inlineCode.some((span, index) => !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
    span.start < (index ? inlineCode[index - 1].end : 0) || span.end < span.start || span.end > rendered.length)) return false;
  while (left < source.length || right < rendered.length) {
    const code = inlineCode[codeIndex];
    if (code?.start === right && source[left] !== '`') {
      codeIndex++;
      continue;
    }
    if (code?.start === right) {
      if (source[left - 1] === '`') return false;
      let width = 0;
      while (source[left + width] === '`') width++;
      if (!width) return false;
      let end = left + width;
      while (true) {
        end = source.indexOf('`', end);
        if (end === -1) return false;
        let closingWidth = 0;
        while (source[end + closingWidth] === '`') closingWidth++;
        if (closingWidth === width) break;
        end += closingWidth;
      }
      let literal = source.slice(left + width, end).replace(/\r\n|\r|\n/g, ' ');
      if (literal.startsWith(' ') && literal.endsWith(' ') && /[^ ]/.test(literal)) literal = literal.slice(1, -1);
      if (rendered.slice(code.start, code.end) !== literal) return false;
      left = end + width; right = code.end; codeIndex++;
      continue;
    }
    if (rendered[right] === '[' && (source.startsWith('https://', left) || source.startsWith('http://', left))) {
      const sourceURL = source.slice(left).match(/^https?:\/\/[^\s"<>]+/)?.[0];
      if (sourceURL) {
        const labelEnd = escapedLiteralEnd(sourceURL, rendered, right + 1);
        if (labelEnd !== null && rendered.startsWith('](', labelEnd)) {
          const destinationEnd = escapedLiteralEnd(sourceURL, rendered, labelEnd + 2);
          if (destinationEnd !== null && rendered[destinationEnd] === ')') {
            left += sourceURL.length;
            right = destinationEnd + 1;
            continue;
          }
        }
      }
    }
    let sourceSlashes = 0, renderedSlashes = 0;
    while (source[left] === '\\') { left++; sourceSlashes++; }
    while (rendered[right] === '\\' && right !== code?.start) { right++; renderedSlashes++; }
    if (renderedSlashes < sourceSlashes || renderedSlashes > sourceSlashes * 2 + Number(asciiPunctuation(source[left]))) return false;
    if (code?.start === right) continue;
    if (source[left] !== rendered[right]) return false;
    left++; right++;
  }
  return codeIndex === inlineCode.length;
}

const requestMessages = (record, messages) => messages.filter(message => message.role === 'user' &&
  !record.baselineIds.includes(message.id) && (message.id === record.userMessageId ||
    matchesRenderedText(`Review request UUID: ${record.id}`, message.text.split('\n', 1)[0])));

function assertRequestContent(record, message) {
  if (!matchesRenderedText(record.prompt, message.text, message.inlineCode) &&
      !matchesRenderedText(encodeReviewPrompt(record.prompt), message.text, message.inlineCode)) {
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
    try { return JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new RelayError('review_missing', 'No review is recorded for this ID.', 404);
      throw error;
    }
  }

  save(record, update, exclusive = false) {
    const next = { ...record, ...update, updatedAt: new Date().toISOString() };
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
      await this.browser.execute({ action: 'navigate', url: previous.conversationURL }, signal, deadlineAt);
      while (true) {
        view = await this.browser.reviewView(signal);
        this.project.assertURL(project, view.url);
        if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
        if (view.composer) break;
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
      const encodedPrompt = encodeReviewPrompt(record.prompt);
      const resumeDraft = (['preparing', 'failed'].includes(record.state) || knownUnsent) &&
        (before.draft === record.prompt || before.draft === encodedPrompt);
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
    const responseError = [user, ...following].map((message) => message.error).filter(Boolean).join('\n');
    if (responseError) throw new RelayError('response_failed', responseError);
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
      await this.browser.execute({ action: 'navigate', url: record.conversationURL }, signal, deadlineAt);
      while (true) {
        view = await this.browser.reviewView(signal);
        this.project.assertURL(project, view.url);
        if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
        if (view.composer) break;
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
