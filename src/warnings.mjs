export function redactNavigationWarning(warning) {
  if (warning.name !== 'electron' || typeof warning.message !== 'string' || !warning.message.startsWith('Failed to load URL: ')) return;
  const code = warning.message.match(/ with error: (ERR_[A-Z0-9_]{1,64})$/)?.[1];
  warning.message = code ? `Page navigation failed (${code}).` : 'Page navigation failed.';
  warning.stack = `${warning.name}: ${warning.message}`;
}
