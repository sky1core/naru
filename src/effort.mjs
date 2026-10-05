import { randomUUID } from 'node:crypto';
import { RelayError } from './protocol.mjs';

export async function selectEffort(browser, effort, view, documentId, signal, deadlineAt, expectedHistory, phase) {
  const trigger = { attribute: 'data-codex-intelligence-trigger', value: 'true',
    ...(view.composer.scope ? { scope: view.composer.scope } : {}) };
  const slider = { attribute: 'data-reasoning-slider', value: 'true', scope: { attribute: 'data-model-picker-view', value: 'simple' } };
  const inspect = (input) => {
    phase(`effort.${input.action === 'wait' ? `wait_${input.condition}` : input.action}`);
    return browser.effort({ ...input, trigger, deadlineAt }, documentId, signal);
  };
  const execute = (input, step) => {
    phase(`effort.${step}`);
    return browser.execute({ ...input, documentId, expectedHistory, expectedURL: view.url,
      expectedText: { target: view.composer, text: view.draft } }, signal, deadlineAt);
  };
  let state = await inspect({ action: 'read' });
  if (!state.open) {
    await execute({ action: 'click', target: trigger }, 'open');
    state = await inspect({ action: 'wait', condition: 'open' });
  }
  if (state.view === 'advanced') {
    await execute({ action: 'click', target: { attribute: 'data-model-picker-view-toggle', value: 'true',
      scope: { attribute: 'data-model-picker-view', value: 'advanced' } } }, 'simplify');
    state = await inspect({ action: 'wait', condition: 'simple' });
  }
  const step = async (key) => {
    const previous = state;
    await execute({ action: 'press', target: slider, key }, key === 'ArrowLeft' ? 'move_left' : 'move_right');
    state = await inspect({ action: 'wait', condition: 'changed', previous });
    if (state.min !== previous.min || state.max !== previous.max ||
        (key === 'ArrowLeft' ? state.value >= previous.value : state.value <= previous.value)) {
      throw new RelayError('effort_unavailable', 'Effort slider changed bounds or did not move in the requested direction.');
    }
  };
  while (state.effort !== effort && state.value > state.min) await step('ArrowLeft');
  while (state.effort !== effort && state.value < state.max) await step('ArrowRight');
  if (state.effort !== effort) throw new RelayError('effort_unavailable', `Requested effort ${effort} is not available.`);
  const token = randomUUID();
  const selected = await inspect({ action: 'arm', effort, token });
  try {
    await execute({ action: 'press', target: slider, key: 'Escape', dismissEffortToken: token }, 'dismiss');
    await inspect({ action: 'wait', condition: 'closed' });
    return { token, selected };
  } catch (error) {
    await browser.releaseEffort(token);
    throw error;
  }
}
