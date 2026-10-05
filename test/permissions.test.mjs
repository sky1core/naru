import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionPolicy } from '../src/permissions.mjs';

test('ChatGPT persistent storage remains granted across fresh app policies without broadening permissions', () => {
  for (let boot = 0; boot < 2; boot++) {
    const policy = permissionPolicy();
    assert.equal(policy.get('persistent-storage', 'https://chatgpt.com/g/project'), true);
    for (const url of ['http://chatgpt.com/', 'https://chatgpt.com.evil.invalid/', 'https://other.invalid/', 'file:///tmp/page']) {
      assert.notEqual(policy.get('persistent-storage', url), true);
    }
    for (const permission of ['media', 'camera', 'microphone', 'notifications']) {
      assert.notEqual(policy.get(permission, 'https://chatgpt.com/'), true);
    }
  }
});

test('a denial is retained for this run, and an interactive grant does not survive restart', () => {
  const policy = permissionPolicy();
  policy.set('notifications', 'https://chatgpt.com/', false);
  assert.equal(policy.get('notifications', 'https://chatgpt.com/c/example'), false);
  policy.set('media', 'https://chatgpt.com/', true);
  assert.equal(policy.get('media', 'https://chatgpt.com/c/example'), true);
  assert.equal(permissionPolicy().get('media', 'https://chatgpt.com/'), undefined);
});
