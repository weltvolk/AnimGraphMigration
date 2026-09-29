/** Line-oriented Enfusion text syntax. No evaluation or regular-expression parsing of blocks. */
export class MigrationSyntaxError extends Error {
  constructor(message, { source = '<input>', line = 1, column = 1 } = {}) {
    super(`${source}:${line}:${column}: ${message}`);
    this.name = 'MigrationSyntaxError';
    this.source = source;
    this.line = line;
    this.column = column;
  }
}

export function parseDocument(text, { source = '<input>' } = {}) {
  if (typeof text !== 'string') throw new TypeError('Document must be a string');
  const tokens = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let column = 1;
  const fail = (message, at = { line, column }) => { throw new MigrationSyntaxError(message, { source, ...at }); };
  const advance = () => {
    const c = text[index++];
    if (c === '\n') { line++; column = 1; } else column++;
    return c;
  };
  while (index < text.length) {
    const c = text[index];
    if (c === '\r' || c === ' ' || c === '\t') { advance(); continue; }
    if (c === '\n') { tokens.push({ type: 'newline', line, column }); advance(); continue; }
    if (c === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') advance();
      continue;
    }
    if (c === '/' && text[index + 1] === '*') {
      const start = { line, column };
      advance(); advance();
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') tokens.push({ type: 'newline', line, column });
        advance();
      }
      if (index === text.length) fail('Unterminated block comment', start);
      advance(); advance();
      continue;
    }
    if (c === '{' || c === '}') { tokens.push({ type: c, line, column }); advance(); continue; }
    const start = { line, column };
    if (c === '"') {
      advance();
      let value = '';
      let closed = false;
      while (index < text.length) {
        const current = advance();
        if (current === '"') { closed = true; break; }
        if (current === '\n' || current === '\r') fail('Newline inside quoted string', start);
        if (current === '\\') {
          if (index >= text.length) fail('Unterminated escape in quoted string', start);
          const escaped = advance();
          if (escaped === '\n' || escaped === '\r') fail('Newline inside quoted string', start);
          const escapes = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' };
          // Preserve unknown escapes (for example a legacy Windows resource path).
          value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : '\\' + escaped;
        } else {
          if (current.charCodeAt(0) < 32) fail('Control character in quoted string', start);
          value += current;
        }
      }
      if (!closed) fail('Unterminated quoted string', start);
      if (index < text.length && !/[\s{}]/u.test(text[index]) && text.slice(index, index + 2) !== '//' && text.slice(index, index + 2) !== '/*') fail('Expected whitespace after quoted string');
      tokens.push({ type: 'value', value, quoted: true, ...start });
      continue;
    }
    let value = '';
    while (index < text.length && !/[\s{}"]/u.test(text[index])) {
      if (text[index].charCodeAt(0) < 32) fail('Control character in token');
      value += advance();
    }
    if (!value) fail('Unexpected character');
    tokens.push({ type: 'value', value, quoted: false, ...start });
  }
  let cursor = 0;
  const skipNewlines = () => { while (tokens[cursor]?.type === 'newline') cursor++; };
  function parseEntries(nested = false, depth = 0) {
    if (depth > 128) fail('Maximum block nesting depth exceeded', tokens[cursor]);
    const entries = [];
    while (cursor < tokens.length) {
      skipNewlines();
      if (cursor === tokens.length) break;
      if (tokens[cursor].type === '}') {
        if (!nested) fail('Unexpected closing brace', tokens[cursor]);
        cursor++;
        return entries;
      }
      if (tokens[cursor].type === '{') fail('Opening brace without a header', tokens[cursor]);
      const head = [];
      while (tokens[cursor]?.type === 'value') {
        const { type: _type, ...token } = tokens[cursor++];
        head.push(token);
      }
      const entry = { head, children: null, line: head[0].line };
      skipNewlines();
      if (tokens[cursor]?.type === '{') {
        cursor++;
        entry.children = parseEntries(true, depth + 1);
      }
      entries.push(entry);
    }
    if (nested) fail('Unclosed block');
    return entries;
  }
  return parseEntries();
}

export const values = entry => entry.head.map(token => token.value);
export const children = (entry, name) => (entry.children ?? []).filter(item => item.head[0]?.value === name);
export const child = (entry, name) => children(entry, name)[0];
export const quote = value => JSON.stringify(String(value));

export function serialize(entries, { indent = ' ' } = {}) {
  function emit(items, depth) {
    return items.map(entry => {
      const head = entry.head.map(token => token.quoted ? quote(token.value) : String(token.value)).join(' ');
      const prefix = indent.repeat(depth);
      if (entry.children === null) return prefix + head + '\n';
      return prefix + head + ' {\n' + emit(entry.children, depth + 1) + prefix + '}\n';
    }).join('');
  }
  return emit(entries, 0);
}
