const { ipcRenderer } = require('electron');
ipcRenderer.sendSync('chatgpt-relay-frame-guard', 'ready');
let active = null;

const eventTypes = {
  fill: new Set(['beforeinput']),
  press: new Set(['keydown', 'keyup']),
  click: new Set(['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']),
};
const terminalEvents = { fill: 'beforeinput', press: 'keyup', click: 'pointerup' };

for (const type of ['beforeinput', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
  window.addEventListener(type, (event) => {
    if (!event.isTrusted) return;
    if (ipcRenderer.sendSync('chatgpt-relay-frame-guard', type, active?.token)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!active || !event.isTrusted || !eventTypes[active.action].has(type)) return;
    const { element, action } = active;
    const correctContext = active.verifyContext();
    const correctTarget = correctContext && active.verifyTarget() && element.isConnected &&
      (event.target === element || element.contains(event.target)) &&
      (action === 'click' || document.activeElement === element);
    const focusRelease = type === 'keyup' && ((event.key === 'Tab' && active.tabAccepted) || (event.key === 'Escape' && active.escapeAccepted));
    if (active.blocked || !correctContext || (!correctTarget && !focusRelease)) {
      active.blocked = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (type === 'keydown' && event.key === 'Escape' && active.releaseOnEscape && !active.blocked) active.escapeAccepted = true;
    if (type === 'keydown' && event.key === 'Tab' && !active.blocked) {
      active.tabAccepted = true;
      ipcRenderer.sendSync('chatgpt-relay-frame-guard', 'tab-accepted', active.token);
    }
    if (type === terminalEvents[action] || active.blocked) {
      active.finished = true;
      if (active.resolve) active.resolve({ blocked: active.blocked });
    }
  }, true);
}

globalThis.chatgptRelayInput = {
  isCurrent(token) {
    return ipcRenderer.sendSync('chatgpt-relay-frame-guard', 'context', token);
  },
  arm(element, action, token, verifyContext, verifyTarget, releaseOnEscape = false) {
    active = { element, action, token, verifyContext, verifyTarget, releaseOnEscape, blocked: false, finished: false };
  },
  finish(token) {
    if (!active || active.token !== token) return Promise.resolve({ blocked: true });
    if (active.finished || active.action === 'fill') {
      const result = { blocked: active.blocked || (!active.finished && document.activeElement !== active.element) };
      active = null;
      return Promise.resolve(result);
    }
    return new Promise((resolve) => {
      active.resolve = (result) => { active = null; resolve(result); };
    });
  },
  cancel(token) {
    if (active?.token !== token) return;
    if (active.resolve) active.resolve({ blocked: true });
    active = null;
  },
};
