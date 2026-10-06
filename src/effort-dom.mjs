export function inspectEffort(input) {
  const fail = (message) => { throw new Error(message); };
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
  const unique = (root, selector, visibleOnly = true) => {
    const nodes = [...root.querySelectorAll(selector)].filter(node => !visibleOnly || visible(node));
    if (nodes.length !== 1) fail(`Expected one effort control: ${selector}`);
    return nodes[0];
  };
  const scopeNode = target => unique(target.scope ? scopeNode(target.scope) : document,
    `[${target.attribute}="${CSS.escape(target.value)}"]`, false);
  const triggerNode = () => {
    const scope = scopeNode(input.trigger.scope);
    return unique(scope, '[data-codex-intelligence-trigger="true"]');
  };
  const read = () => {
    const trigger = triggerNode();
    const expanded = trigger.getAttribute('aria-expanded');
    if (!['true', 'false'].includes(expanded)) fail('Effort menu has no explicit expansion state.');
    const raw = trigger.getAttribute('data-selected-reasoning-effort');
    if (!['none', 'medium', 'high', 'max'].includes(raw)) fail('Unknown selected reasoning effort.');
    if (expanded === 'false') return { open: false, raw };
    const menu = unique(document, '[role="menu"][data-state="open"]');
    const picker = unique(menu, '[data-model-picker-view]');
    const view = picker.getAttribute('data-model-picker-view');
    if (!['simple', 'advanced'].includes(view)) fail('Unknown effort picker view.');
    const badge = unique(picker, '[data-model-picker-view-toggle="true"] [data-maximum]');
    const maximum = badge.getAttribute('data-maximum');
    if (!['true', 'false'].includes(maximum) || (maximum === 'true' && raw !== 'medium')) fail('Ambiguous effort state.');
    const state = { open: true, view, raw, maximum: maximum === 'true', effort: maximum === 'true' ? 'pro' : raw };
    if (view === 'advanced') return state;
    const control = unique(picker, '[data-reasoning-slider="true"]');
    if (control.hasAttribute('data-disabled') || control.getAttribute('aria-disabled') === 'true') fail('Effort control is disabled.');
    const slider = unique(control, '[role="slider"]');
    const numbers = ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].map(name => {
      const value = slider.getAttribute(name);
      if (value === null || !value.trim() || !Number.isSafeInteger(Number(value))) fail('Invalid effort slider bounds.');
      return Number(value);
    });
    const [min, max, value] = numbers;
    if (min > value || value > max) fail('Effort slider is outside its bounds.');
    return { ...state, min, max, value };
  };
  if (input.action === 'release') {
    if (globalThis.naruEffortReceipt?.token === input.token) {
      globalThis.naruEffortReceipt.release();
      delete globalThis.naruEffortReceipt;
    }
    return {};
  }
  if (input.action === 'wait') {
    return new Promise(resolve => {
      let timer;
      const observer = new MutationObserver(check);
      function finish(result) { observer.disconnect(); clearTimeout(timer); resolve(result); }
      function check() {
        try {
          const state = read();
          const matches = input.condition === 'open' ? state.open
            : input.condition === 'closed' ? !state.open
              : input.condition === 'simple' ? state.open && state.view === 'simple'
                : state.open && state.value !== input.previous.value &&
                  (state.raw !== input.previous.raw || state.maximum !== input.previous.maximum);
          if (matches) finish(state);
        } catch (error) { finish({ error: { code: 'effort_unavailable', message: error.message } }); }
      }
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      timer = setTimeout(() => finish({ error: { code: 'effort_timeout', message: 'Requested effort state was not observed before the deadline.' } }), Math.max(0, input.deadlineAt - Date.now()));
      check();
    });
  }
  try {
    const state = read();
    if (input.action !== 'arm') return state;
    if (!state.open || state.effort !== input.effort) fail('Requested effort is not selected.');
    const trigger = triggerNode();
    const menu = unique(document, '[role="menu"][data-state="open"]');
    const badge = unique(menu, '[data-model-picker-view-toggle="true"] [data-maximum]');
    let invalid = false;
    const changed = (records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          if ([...record.removedNodes].some(node => node.contains(badge) && !node.contains(menu))) invalid = true;
          if ([...record.addedNodes].some(node => node instanceof Element &&
              (node.matches('[data-model-picker-view]') || node.querySelector('[data-model-picker-view]')))) invalid = true;
        }
        if (record.target === trigger && (record.attributeName === 'data-selected-reasoning-effort' ||
            (record.attributeName === 'aria-expanded' && record.oldValue !== 'true'))) invalid = true;
        if (record.target === badge && record.attributeName === 'data-maximum') invalid = true;
      }
    };
    const observer = new MutationObserver(changed);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['data-selected-reasoning-effort', 'aria-expanded', 'data-maximum'] });
    globalThis.naruEffortReceipt?.release();
    globalThis.naruEffortReceipt = {
      token: input.token,
      release: () => observer.disconnect(),
      verify: (allowOpen = false) => {
        changed(observer.takeRecords());
        try {
          if (trigger.getAttribute('aria-expanded') === 'true' &&
              (unique(document, '[role="menu"][data-state="open"]') !== menu ||
               unique(menu, '[data-model-picker-view-toggle="true"] [data-maximum]') !== badge ||
               badge.getAttribute('data-maximum') !== String(state.maximum))) return false;
          return !invalid && trigger.isConnected && triggerNode() === trigger &&
            trigger.getAttribute('data-selected-reasoning-effort') === state.raw && (trigger.getAttribute('aria-expanded') === 'false' || (allowOpen && trigger.getAttribute('aria-expanded') === 'true'));
        } catch { return false; }
      },
    };
    return state;
  } catch (error) { return { error: { code: 'effort_unavailable', message: error.message } }; }
}
