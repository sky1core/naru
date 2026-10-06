function backtickClosures(text) {
  const closures = new Uint32Array(text.length), next = new Map();
  for (let end = text.length; end > 0;) {
    if (text.charCodeAt(end - 1) !== 96) { end--; continue; }
    const runEnd = end;
    while (end > 0 && text.charCodeAt(end - 1) === 96) end--;
    const size = runEnd - end;
    closures[end] = next.get(size) ?? 0;
    next.set(size, end + 1);
  }
  return closures;
}

export function reviewInlineCodeContext(source) {
  const start = source.indexOf('\n{"id":') + 1;
  if (!start) return new Map();
  const end = source.indexOf('\n', start), text = source.slice(start, end);
  const closures = backtickClosures(text);
  return { get(offset) {
    const position = offset - start, close = closures[position];
    if (!close) return undefined;
    let contentStart = position + 1;
    while (text.charCodeAt(contentStart) === 96) contentStart++;
    const contentEnd = close - 1;
    return { contentStart: start + contentStart, contentEnd: start + contentEnd,
      end: start + contentEnd + contentStart - position };
  } };
}
