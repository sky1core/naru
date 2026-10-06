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
  const audio = { mediaTypes: ['audio'] };
  policy.set('media', 'https://chatgpt.com/', true, audio);
  assert.equal(policy.get('media', 'https://chatgpt.com/c/example', audio), true);
  assert.equal(permissionPolicy().get('media', 'https://chatgpt.com/', audio), undefined);
});

test('microphone approval does not grant a camera or a combined media request', () => {
  const policy = permissionPolicy();
  const url = 'https://chatgpt.com/';
  policy.set('media', url, true, { mediaTypes: ['audio'] });
  assert.equal(policy.get('media', url, { mediaTypes: ['audio'] }), true);
  assert.equal(policy.get('media', url, { mediaTypes: ['video'] }), undefined);
  assert.equal(policy.get('media', url, { mediaTypes: ['audio', 'video'] }), undefined);
  policy.set('media', url, false, { mediaTypes: ['video'] });
  assert.equal(policy.get('media', url, { mediaTypes: ['audio'] }), true);
  assert.equal(policy.get('media', url, { mediaTypes: ['audio', 'video'] }), false);
});

test('a combined media approval records each explicitly requested scope', () => {
  const policy = permissionPolicy();
  const url = 'https://site.invalid/';
  policy.set('media', url, true, { mediaTypes: ['video', 'audio'] });
  for (const mediaTypes of [['audio'], ['video'], ['audio', 'video'], ['video', 'audio', 'audio']]) {
    assert.equal(policy.get('media', url, { mediaTypes }), true);
  }
  assert.equal(policy.get('media', 'https://other.invalid/', { mediaTypes: ['audio'] }), undefined);
});

test('file approval is specific to its path, access type and file or directory scope', () => {
  const policy = permissionPolicy();
  const url = 'https://site.invalid/';
  const scope = { filePath: '/tmp/selected-file', fileAccessType: 'readable', isDirectory: false };
  policy.set('fileSystem', url, true, scope);
  assert.equal(policy.get('fileSystem', url, scope), true);
  for (const changed of [
    { ...scope, filePath: '/tmp/other-file' },
    { ...scope, fileAccessType: 'writable' },
    { ...scope, isDirectory: true },
    { filePath: '/tmp/other-directory', fileAccessType: 'writable', isDirectory: true },
  ]) {
    assert.equal(policy.get('fileSystem', url, changed), undefined);
  }
  assert.equal(permissionPolicy().get('fileSystem', url, scope), undefined);
});

test('missing or invalid sensitive permission scopes never grant access', () => {
  const policy = permissionPolicy();
  const url = 'https://site.invalid/';
  const file = { filePath: '/tmp/selected-file', fileAccessType: 'readable', isDirectory: false };
  const scopes = [
    ['media', undefined], ['media', {}], ['media', { mediaTypes: [] }],
    ['media', { mediaTypes: ['unknown'] }], ['media', { mediaTypes: ['audio', 'unknown'] }],
    ['media', { mediaTypes: 'audio' }], ['media', { mediaTypes: [null] }],
    ['media', { mediaTypes: new Array(1) }], ['media', { mediaTypes: ['audio', ,] }],
    ['fileSystem', undefined], ['fileSystem', {}],
    ...Object.keys(file).map(key => ['fileSystem', { ...file, [key]: undefined }]),
    ['fileSystem', { ...file, filePath: '' }],
    ['fileSystem', { ...file, filePath: 'relative-file' }],
    ['fileSystem', { ...file, fileAccessType: 'readwrite' }],
    ['fileSystem', { ...file, isDirectory: 'false' }],
  ];
  for (const [permission, scope] of scopes) {
    policy.set(permission, url, true, scope);
    assert.equal(policy.get(permission, url, scope), false);
  }
  assert.equal(policy.get('media', url, { mediaTypes: ['audio'] }), undefined);
  assert.equal(policy.get('fileSystem', url, file), undefined);
});
