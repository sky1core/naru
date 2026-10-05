export function inspectDOM(input) {
  const attributes = ['id', 'data-testid', 'name', 'type', 'href', 'data-message-id', 'data-message-author-role', 'data-composer-markdown', 'data-chatgpt-composer', 'data-composer-placement', 'data-app-action-sidebar-project-id', 'data-codex-intelligence-trigger', 'data-model-picker-view-toggle', 'data-map-composer-conversation', 'data-reasoning-slider', 'data-model-picker-view'];
  const failure = (code, message) => ({ error: { code, message } });
  const matches = (target) => {
    const roots = target.scope ? matches(target.scope) : [document];
    if (!roots || roots.length !== 1) return null;
    return Array.from(roots[0].querySelectorAll(`[${target.attribute}]`))
      .filter((element) => element.getAttribute(target.attribute) === target.value);
  };
  const literalText = (parent, copyContent = false) => {
    const parentVisible = getComputedStyle(parent).visibility === 'visible';
    let result = '';
    const inlineCode = [];
    let previousBlock = false;
    let seen = false;
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!parentVisible) continue;
        if (previousBlock && (!copyContent || !result.endsWith('\n') && !node.nodeValue.startsWith('\n'))) result += '\n';
        result += node.nodeValue;
        previousBlock = false;
        seen = true;
      } else if (node instanceof HTMLElement) {
        if (copyContent && node.getAttribute('data-markdown-copy') === 'exclude') continue;
        const style = getComputedStyle(node);
        if (style.display === 'none') continue;
        if (node.tagName === 'BR') {
          if (style.visibility !== 'visible') continue;
          if (parent.childNodes.length !== 1) result += '\n';
          previousBlock = false;
          seen = true;
          continue;
        }
        const child = literalText(node, copyContent);
        const childText = child.text;
        if (style.visibility !== 'visible' && childText === '') continue;
        const block = ['block', 'list-item', 'flow-root'].includes(style.display);
        if (seen && (block || previousBlock) && (!copyContent || !result.endsWith('\n') && !childText.startsWith('\n'))) result += '\n';
        if (copyContent && !node.closest('pre, [data-markdown-copy="code-block"]') &&
            (node.tagName === 'CODE' || node.getAttribute('data-markdown-copy') === 'inline-code')) {
          inlineCode.push({ start: result.length, end: result.length + childText.length });
        } else {
          inlineCode.push(...child.inlineCode.map(span => ({ start: result.length + span.start, end: result.length + span.end })));
        }
        result += childText;
        previousBlock = block;
        seen = true;
      }
    }
    return { text: result, inlineCode };
  };
  const text = (element) => {
    if (element instanceof HTMLInputElement && element.type === 'password') throw new Error('password_field');
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
    return element.isContentEditable ? literalText(element).text : element.innerText;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible';
  };

  if (input.action === 'readCopyText') return literalText(input.element, true);

  if (input.action === 'cancel-wait') {
    globalThis.naruDOMWaits?.get(input.token)?.();
    return {};
  }

  if (input.action === 'snapshot') {
    const elements = Array.from(document.querySelectorAll('*')).filter((element) =>
      ['BUTTON', 'FORM', 'CODE', 'PRE'].includes(element.tagName) || element.hasAttribute('role') || element.hasAttribute('class') ||
      Array.from(element.attributes).some(({ name }) => attributes.includes(name) || name.startsWith('data-') || ['aria-busy', 'aria-live'].includes(name)));
    const elementIndexes = new Map(elements.map((element, index) => [element, index]));
    const parentIndex = (element) => {
      let parent = element.parentElement;
      while (parent && !elementIndexes.has(parent)) parent = parent.parentElement;
      return parent ? elementIndexes.get(parent) : null;
    };
    return { title: document.title, url: location.href, elements: elements.map((element) => ({
      tag: element.tagName.toLowerCase(), parentIndex: parentIndex(element),
      attributes: Object.fromEntries(attributes.filter((attr) => element.hasAttribute(attr)).map((attr) => [attr, element.getAttribute(attr)])),
      structure: Object.fromEntries(Array.from(element.attributes).filter(({ name }) => name.startsWith('data-') || ['class', 'type', 'role', 'aria-haspopup', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-busy', 'aria-live', 'aria-hidden', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow'].includes(name)).map(({ name, value }) => [name, value])),
      visible: visible(element),
      editable: element.isContentEditable || element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement,
    })) };
  }

  if (input.action === 'wait') {
    return new Promise((resolve) => {
      let timer;
      let frame;
      let done = false;
      const observer = new MutationObserver(check);
      function finish(result) {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        globalThis.naruDOMWaits.delete(input.token);
        resolve(result);
      }
      function check() {
        if (done) return;
        const found = matches(input.target);
        if (!found) return finish(failure('invalid_scope', 'Scope must match exactly one element.'));
        if (found.length > 1) return finish(failure('ambiguous_target', 'More than one element matches.'));
        if (input.state === 'absent' ? found.length === 0 : found.length === 1 && visible(found[0])) {
          finish({ state: input.state });
        }
      }
      if (!globalThis.naruDOMWaits) globalThis.naruDOMWaits = new Map();
      globalThis.naruDOMWaits.set(input.token, () => finish(failure('command_timeout', 'Command expired while waiting for the target.')));
      observer.observe(document, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => finish(failure('wait_timeout', 'Target condition was not observed.')), input.timeoutMs);
      function checkFrame() {
        check();
        if (!done) frame = requestAnimationFrame(checkFrame);
      }
      frame = requestAnimationFrame(checkFrame);
      check();
    });
  }

  const found = matches(input.target);
  if (!found) return failure('invalid_scope', 'Scope must match exactly one element.');
  if (!found.length) return failure('target_missing', 'No element matches the explicit target.');
  if (found.length !== 1) return failure('ambiguous_target', 'More than one element matches.');
  const element = found[0];
  if (input.action === 'read') {
    try { return { text: text(element) }; }
    catch { return failure('password_field', 'Password values are not exposed.'); }
  }
  if (!visible(element)) return failure('target_hidden', 'Target is not visible.');
  if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return failure('target_disabled', 'Target is disabled.');
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
  const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(element === hit || element.contains(hit))) return failure('target_obscured', 'Another element covers the target.');
  const verifyContext = () => {
    if (Date.now() >= input.deadlineAt) return false;
    if (location.href !== input.documentURL || !globalThis.chatgptRelayInput.isCurrent(input.token)) return false;
    if (input.expectedURL && location.href !== input.expectedURL) return false;
    if (input.dismissEffortToken && (globalThis.naruEffortReceipt?.token !== input.dismissEffortToken || !globalThis.naruEffortReceipt.verify(true))) return false;
    if (input.effortToken && (globalThis.naruEffortReceipt?.token !== input.effortToken || !globalThis.naruEffortReceipt.verify())) return false;
    if (input.expectedHistory !== undefined) {
      const view = globalThis.chatgptRelayReviewObserver?.sample();
      if (!view || view.problem || view.busy || (view.historyScrollable && view.historyAtLatest !== true) ||
          JSON.stringify(view.messages) !== input.expectedHistory) return false;
    }
    if (!input.expectedText) return true;
    const expected = matches(input.expectedText.target);
    return expected?.length === 1 && text(expected[0]) === input.expectedText.text;
  };
  if (Date.now() >= input.deadlineAt) return failure('command_timeout', 'Command expired before input preparation.');
  if (!verifyContext()) return failure('draft_conflict', 'Composer or page changed before submission.');
  const verifyTarget = () => {
    const current = matches(input.target);
    return current?.length === 1 && current[0] === element;
  };
  globalThis.chatgptRelayInput.arm(element, input.action, input.token, verifyContext, verifyTarget, Boolean(input.dismissEffortToken));
  if (input.action === 'fill') {
    if (element.readOnly) return failure('target_readonly', 'Target is read-only.');
    if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable)) return failure('target_not_editable', 'Target is not editable.');
    if (element instanceof HTMLInputElement && !['text', 'search', 'url', 'tel', 'email'].includes(element.type)) return failure('unsupported_input', 'Input type is not supported for text insertion.');
    element.focus({ preventScroll: true });
    if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      element.select();
    }
  } else if (input.action === 'press') {
    element.focus({ preventScroll: true });
  }
  if (input.action !== 'click' && document.activeElement !== element) return failure('focus_failed', 'Could not focus the target.');
  if (input.action === 'fill') {
    if (Date.now() >= input.deadlineAt) return failure('command_timeout', 'Command expired before text insertion.');
    if (!verifyContext()) return failure('draft_conflict', 'Composer or page changed before text insertion.');
    const current = matches(input.target);
    if (!element.isConnected || current?.length !== 1 || current[0] !== element || document.activeElement !== element) return failure('target_changed', 'Target changed before text insertion.');
    if (!document.execCommand('insertText', false, input.text)) return failure('input_rejected', 'The browser editing command rejected the text.');
    if (text(element) !== input.text) return failure('input_mismatch', 'Browser value differs from requested text; input was not retried.');
  }
  return { x, y };
}
