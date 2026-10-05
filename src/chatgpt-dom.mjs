export function inspectChatGPT(input, inspectDOM) {
  const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility === 'visible' && getComputedStyle(node).display !== 'none';
  const nodes = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
  const fail = (code, message) => ({ problem: { code, message }, url: location.href, messages: [] });
  const capture = () => {
    if (nodes('#sidebar-login-title').some(visible) || /\/auth\//.test(location.pathname)) {
      return fail('login_required', 'The embedded browser is showing a login or signed-out page.');
    }
    const editors = [...new Set(nodes('#prompt-textarea, [data-chatgpt-composer] [data-composer-markdown][contenteditable="true"]'))].filter(visible);
    if (editors.length > 1) return fail('ambiguous_chatgpt_ui', 'Composer is not unique.');
    const editor = editors[0];
    const form = editor?.closest('form');
    const modernForm = form?.hasAttribute('data-chatgpt-composer');
    const placement = modernForm ? form.getAttribute('data-composer-placement') : null;
    const thread = placement === 'thread' ? form.closest('[data-map-composer-conversation]') : null;
    const scope = placement === 'thread'
      ? (thread ? { attribute: 'data-map-composer-conversation', value: thread.getAttribute('data-map-composer-conversation') } : undefined)
      : placement ? { attribute: 'data-composer-placement', value: placement } : undefined;
    const sends = modernForm ? nodes('[type="submit"]', form) : nodes('[data-testid="send-button"]');
    const conversationId = location.pathname.match(/\/c\/([^/]+)\/?$/)?.[1];
    const conversationActive = Boolean(conversationId) && nodes('[data-thread-title-trigger] a[href]').some(link => {
      if (link.origin !== location.origin || link.pathname.match(/\/c\/([^/]+)\/?$/)?.[1] !== conversationId) return false;
      const row = link.closest('[role="listitem"]');
      return visible(link) && row && nodes('[role="status"]', row).some(status =>
        visible(status) && status.closest('[role="listitem"]') === row);
    });
    const turnActive = nodes('[data-content-search-turn-key]').some(turn =>
      nodes('[data-markdown-animated], [role="status"]', turn).some(node => visible(node) &&
        node.closest('[data-content-search-turn-key]') === turn &&
        (node.hasAttribute('data-markdown-animated') ||
          !node.closest('[data-chatgpt-search-unit-key], [data-message-id][data-message-author-role]'))));
    if (sends.length > 1 || (modernForm && (!scope || nodes(`[${scope.attribute}]`).filter(node => node.getAttribute(scope.attribute) === scope.value).length !== 1))) return fail('ambiguous_chatgpt_ui', 'Composer form or send control is not unique.');
    const composer = editor?.id === 'prompt-textarea' ? { attribute: 'id', value: 'prompt-textarea', ...(scope ? { scope } : {}) }
      : editor?.hasAttribute('data-composer-markdown') ? { attribute: 'data-composer-markdown', value: editor.getAttribute('data-composer-markdown'), scope } : null;
    const legacy = nodes('[data-message-id][data-message-author-role]').filter(visible);
    const units = nodes('[data-chatgpt-search-unit-key]').filter(visible);
    if (legacy.length && units.length) return fail('ambiguous_chatgpt_ui', 'Multiple message DOM formats are present.');
    const layout = units.length ? 'search-unit' : 'message-id';
    const messages = [];
    const ids = new Set();
    for (const node of layout === 'search-unit' ? units : legacy) {
      const role = layout === 'search-unit' ? node.getAttribute('data-chatgpt-search-unit-key').split(':').at(-1) : node.getAttribute('data-message-author-role');
      if (!['user', 'assistant'].includes(role)) continue;
      const messageIds = layout === 'search-unit' ? [...new Set((node.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).filter(Boolean))] : [node.getAttribute('data-message-id')];
      if (messageIds.length !== 1) return fail('ambiguous_message', 'A message unit must identify exactly one message.');
      const id = messageIds[0];
      if (!id || ids.has(id)) return fail('ambiguous_message', 'Messages must have unique nonempty stable identifiers.');
      ids.add(id);
      const turn = node.closest('[data-content-search-turn-key], [data-turn], [data-testid^="conversation-turn-"]');
      const answerBodies = nodes('[data-markdown-text-style="assistant-message"]', node);
      if (answerBodies.length > 1) return fail('ambiguous_response', 'Assistant answer body is not unique.');
      const userBodySelector = '[data-user-message-bubble] [data-search-result-target], [data-testid="collapsible-user-message-content"]';
      const userBodies = nodes(userBodySelector, node).filter(body => {
        const outer = body.parentElement.closest(userBodySelector);
        return !outer || !node.contains(outer);
      });
      if (userBodies.length > 1) return fail('ambiguous_request', 'User message body is not unique.');
      const body = role === 'assistant' && answerBodies.length === 1 ? answerBodies[0]
        : role === 'user' && userBodies.length === 1 ? userBodies[0] : node;
      const copyControls = turn ? nodes('[data-testid="copy-turn-action-button"]', turn).filter(control => {
        const owner = control.closest('[data-chatgpt-search-unit-key], [data-message-id][data-message-author-role]');
        return !owner || owner === node;
      }) : [];
      const actionGroups = turn && layout === 'search-unit' ? nodes('.turn-action-controls', turn).filter(control =>
        control.closest('[data-content-search-turn-key]') === turn && !control.closest('[data-chatgpt-search-unit-key]')) : [];
      const assistantsInTurn = turn && layout === 'search-unit'
        ? nodes('[data-chatgpt-search-unit-key]', turn).filter(unit => unit.getAttribute('data-chatgpt-search-unit-key').split(':').at(-1) === 'assistant' && visible(unit))
        : [];
      if (role === 'assistant' && layout === 'search-unit' && turn && assistantsInTurn.length !== 1) return fail('ambiguous_response', 'Response actions must belong to a turn with one assistant message.');
      const completedCopy = copyControls.length === 1 && visible(copyControls[0]);
      const completedActions = actionGroups.length === 1 && visible(actionGroups[0]) && nodes('button', actionGroups[0]).some(visible);
      const content = role === 'user' && userBodies.length === 1
        ? inspectDOM({ action: 'readCopyText', element: body }) : { text: body.innerText };
      messages.push({ id, role, ...content,
        error: turn ? nodes('[role="alert"]', turn).filter(visible).map((alert) => alert.innerText).filter(Boolean).join('\n') : '',
        complete: role === 'assistant' && (completedCopy || completedActions) });
    }
    const historyScrollers = nodes('[data-app-action-timeline-scroll]').filter(visible);
    const latest = scroller => getComputedStyle(scroller).flexDirection === 'column-reverse'
      ? Math.abs(scroller.scrollTop) <= 1 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const attachedFiles = form ? nodes('input[type="file"]', form).some((node) => node.files.length > 0) : false;
    return { url: location.href, layout, composer, composerPlacement: placement,
      send: sends.length === 1 ? (modernForm
        ? { attribute: 'type', value: 'submit', scope }
        : { attribute: 'data-testid', value: 'send-button' }) : null,
      sendBounds: sends.length === 1 ? sends[0].getBoundingClientRect().toJSON() : null,
      sendEnabled: sends.length === 1 && visible(sends[0]) && !sends[0].matches(':disabled') && sends[0].getAttribute('aria-disabled') !== 'true',
      draft: composer ? inspectDOM({ action: 'read', target: composer }).text : null,
      busy: turnActive || conversationActive || nodes('[data-testid="stop-button"], [data-content-search-turn-key] [role="status"][aria-busy="true"]').some(visible), attachments: attachedFiles,
      historyScrollable: historyScrollers.length > 0,
      historyAtLatest: historyScrollers.length === 1 ? latest(historyScrollers[0]) : null,
      messages };
  };
  if (!globalThis.chatgptRelayReviewObserver) {
    let fingerprint;
    let since;
    const sample = () => {
      const view = capture();
      const next = JSON.stringify(view);
      if (next !== fingerprint) { fingerprint = next; since = performance.now(); }
      return { ...view, stableForMs: performance.now() - since };
    };
    const observer = new MutationObserver(sample);
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    globalThis.chatgptRelayReviewObserver = { sample, observer, waits: new Map() };
  }
  const sample = globalThis.chatgptRelayReviewObserver.sample;
  if (input.action === 'scroll-history') {
    if (location.href !== input.url) return fail('conversation_changed', 'Conversation changed before reading its history.');
    const scrollers = nodes('[data-app-action-timeline-scroll]').filter(visible);
    if (scrollers.length !== 1) return fail('unsupported_chatgpt_ui', 'Conversation history must have one identified scroll container.');
    const scroller = scrollers[0];
    const before = scroller.scrollTop;
    const reverse = getComputedStyle(scroller).flexDirection === 'column-reverse';
    if (input.direction === 'earlier') {
      const anchors = nodes('[data-chatgpt-search-unit-key], [data-message-id][data-message-author-role]', scroller).filter(node =>
        visible(node) && (node.getAttribute('data-message-id') === input.anchorId ||
          (node.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).includes(input.anchorId)));
      if (anchors.length !== 1) return fail('conversation_changed', 'The observed history message is no longer a unique scroll anchor.');
      const distance = anchors[0].getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = before + Math.min(-scroller.clientHeight / 2, distance);
    } else scroller.scrollTop = reverse ? 0 : scroller.scrollHeight;
    const moved = before !== scroller.scrollTop;
    return new Promise(resolve => {
      let frame;
      let done = false;
      const finish = result => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        globalThis.chatgptRelayReviewObserver.waits.delete(input.token);
        resolve(result);
      };
      globalThis.chatgptRelayReviewObserver.waits.set(input.token, () => finish(fail('command_timeout', 'Command expired while reading history.')));
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => finish({ moved })); });
    });
  }
  if (input.action === 'cancel-wait') {
    globalThis.chatgptRelayReviewObserver.waits.get(input.token)?.();
    return;
  }
  if (input.action !== 'wait') return sample();
  return new Promise((resolve) => {
    let timer;
    const observer = new MutationObserver(check);
    function finish() { observer.disconnect(); clearTimeout(timer); globalThis.chatgptRelayReviewObserver.waits.delete(input.token); resolve(); }
    function check() {
      const { stableForMs, ...view } = sample();
      if (JSON.stringify(view) !== input.previous) finish();
    }
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    globalThis.chatgptRelayReviewObserver.waits.set(input.token, finish);
    timer = setTimeout(finish, input.timeoutMs);
    check();
  });
}
