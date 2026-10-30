/**
 * Blank out comments (and Python docstrings) before regex route detection, so examples in docs —
 * `Usage: @app.get("/admin")` in a docstring, a `@GetMapping` in Javadoc — aren't detected as real
 * routes. Every masked character becomes a space and newlines are kept, so offsets and line
 * numbers (evidence) are unchanged. String literals are tracked so `"http://x"` or `"#tag"` stay.
 *
 * Not used for PHP: Symfony routes live INSIDE doc comments (`@Route`) and `#[Route]` starts with #.
 */
export type CommentStyle = 'python' | 'c' | 'ruby';

export const maskComments = (source: string, style: CommentStyle): string => {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const lineComment = style === 'c' ? '//' : '#';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const three = source.slice(i, i + 3);

    // Python docstrings / triple-quoted strings: documentation, never route code.
    if (style === 'python' && (three === '"""' || three === "'''")) {
      const end = source.indexOf(three, i + 3);
      const stop = end === -1 ? source.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Java text blocks are real string literals — keep, but don't scan inside for comments.
    if (style === 'c' && three === '"""') {
      const end = source.indexOf('"""', i + 3);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith(lineComment, i)) {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (style === 'c' && source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Ordinary string literals (Go raw strings use backticks): skip over, honouring escapes.
    if (ch === '"' || ch === "'" || (style === 'c' && ch === '`')) {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\' && ch !== '`') j += 1;
        if (source[j] === '\n' && ch !== '`') break; // unterminated: stop at end of line
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
};
