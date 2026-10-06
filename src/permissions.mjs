import { isWebURL } from './protocol.mjs';
import { isAbsolute } from 'node:path';

export function permissionDetails(permission, details) {
  if (permission === 'media') {
    const mediaTypes = details?.mediaTypes;
    if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return null;
    const types = [...new Set(mediaTypes)];
    if (!types.every(type => type === 'audio' || type === 'video')) return null;
    return { scopes: types.map(type => [type]),
      description: types.map(type => type === 'audio' ? '마이크 (audio)' : '카메라 (video)').join('\n') };
  }
  if (permission === 'fileSystem') {
    const filePath = details?.filePath;
    const fileAccessType = details?.fileAccessType;
    const isDirectory = details?.isDirectory;
    if (typeof filePath !== 'string' || !isAbsolute(filePath) ||
        !['readable', 'writable'].includes(fileAccessType) || typeof isDirectory !== 'boolean') return null;
    return { scopes: [[filePath, fileAccessType, isDirectory]],
      description: `${isDirectory ? '디렉터리' : '파일'}: ${filePath}\n접근: ${fileAccessType === 'readable' ? '읽기 (readable)' : '쓰기 (writable)'}` };
  }
  return { scopes: [[]], description: permission };
}

export function permissionPolicy() {
  const decisions = new Map([[JSON.stringify(['https://chatgpt.com', 'persistent-storage']), true]]);
  const keys = (permission, url, details) => {
    if (!isWebURL(url)) return null;
    const scope = permissionDetails(permission, details);
    if (scope === null) return null;
    return scope.scopes.map(entry => JSON.stringify([new URL(url).origin, permission, ...entry]));
  };
  return {
    get(permission, url, details) {
      const entries = keys(permission, url, details);
      if (entries === null) return false;
      const results = entries.map(entry => decisions.get(entry));
      if (results.some(result => result === false)) return false;
      return results.every(result => result === true) ? true : undefined;
    },
    set(permission, url, allowed, details) {
      const entries = keys(permission, url, details);
      if (entries !== null) for (const entry of entries) decisions.set(entry, allowed);
    },
  };
}
