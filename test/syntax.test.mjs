import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, serialize, values, child, children, quote, MigrationSyntaxError } from '../src/syntax.mjs';

const clean = items => items.map(entry => ({ head: entry.head.map(({ value, quoted }) => ({ value, quoted })), children: entry.children === null ? null : clean(entry.children) }));

test('quoted braces, escaped quotes, comments, BOM, CRLF and next-line blocks are parsed', () => {
  const text = '\ufeffRoot\r\n{\r\n // ignore {\r\n Value "literal { } \\" quoted"\r\n /* block\r\n comment */\r\n Nested {}\r\n Repeated "a"\r\n Repeated "b"\r\n}\r\n';
  const parsed = parseDocument(text, { source: 'fixture.aw' });
  assert.equal(values(child(parsed[0], 'Value'))[1], 'literal { } " quoted');
  assert.equal(children(parsed[0], 'Repeated').length, 2);
  assert.equal(child(parsed[0], 'Value').line, 4);
  assert.deepEqual(clean(parseDocument(serialize(parsed))), clean(parsed));
});

test('quoted values round trip without evaluating expressions or losing escapes', () => {
  for (const value of ['path\\file', 'say "hello"', 'line\nnext\ttab', 'ä{}//', '$x && GetVar()']) {
    const parsed = parseDocument('Value ' + quote(value));
    assert.equal(values(parsed[0])[1], value);
  }
});

test('malformed blocks and strings carry file and line information', () => {
  for (const text of ['Root {', '}', '{ Value }', 'Value "unclosed', '/* unterminated', 'Value "a"garbage', 'Value "line\nnext"']) {
    assert.throws(() => parseDocument(text, { source: 'broken.agr' }), error => error instanceof MigrationSyntaxError && /broken\.agr:\d+:\d+:/u.test(error.message));
  }
});

test('deep nesting is bounded', () => {
  assert.throws(() => parseDocument('N {\n'.repeat(130) + '}\n'.repeat(130)), /nesting depth/u);
});
