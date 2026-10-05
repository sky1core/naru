import { isWebURL } from './protocol.mjs';

export function permissionPolicy() {
  const decisions = new Map([['https://chatgpt.com|persistent-storage', true]]);
  const key = (permission, url) => isWebURL(url) ? `${new URL(url).origin}|${permission}` : null;
  return {
    get(permission, url) { return decisions.get(key(permission, url)); },
    set(permission, url, allowed) {
      const entry = key(permission, url);
      if (entry !== null) decisions.set(entry, allowed);
    },
  };
}
