import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTxaImportMeta } from '../src/native-import-resources.mjs';
import { parseDocument, values, child } from '../src/syntax.mjs';

const example = () => ({ resourcePath: 'Example/candidate/Move.anm', guid: '0123456789abcdef' });

test('TXA metadata declares the target resource, neighboring source and inherited platform configurations', () => {
  const input = example(), unchanged = structuredClone(input);
  const text = generateTxaImportMeta(input);
  assert.deepEqual(input, unchanged);
  const [root] = parseDocument(text);
  assert.deepEqual(values(root), ['MetaFileClass']);
  assert.deepEqual(values(child(root, 'Name')), ['Name', '{0123456789ABCDEF}Example/candidate/Move.anm']);
  const configurations = child(root, 'Configurations').children;
  assert.deepEqual(configurations.map(values), [
    ['TXAResourceClass', 'PC'], ['TXAResourceClass', 'XBOX_ONE', ':', 'PC'],
    ['TXAResourceClass', 'PS4', ':', 'PC'], ['TXAResourceClass', 'LINUX', ':', 'PC'],
  ]);
  assert.deepEqual(configurations[0].children.map(values), [['SourceFile', 'Move.txa']]);
  assert.ok(configurations.slice(1).every(configuration => configuration.children.length === 0));
  assert.equal(text, generateTxaImportMeta(input));
  assert.ok(text.endsWith('\n'));
});

test('resource separators normalize while case, spaces and an explicit neighboring source remain intact', () => {
  const text = generateTxaImportMeta({ resourcePath: 'Example\\Animations\\Slow Move.ANM', guid: 'ABCDEF0123456789', sourceFile: 'Source Move.TXA' });
  const [root] = parseDocument(text);
  assert.equal(values(child(root, 'Name'))[1], '{ABCDEF0123456789}Example/Animations/Slow Move.ANM');
  assert.equal(values(child(child(root, 'Configurations').children[0], 'SourceFile'))[1], 'Source Move.TXA');
});

test('candidate and control metadata carry caller-provided independent resource identities', () => {
  const candidate = generateTxaImportMeta({ resourcePath: 'Example/candidate/Move.anm', guid: '1111111111111111' });
  const control = generateTxaImportMeta({ resourcePath: 'Example/control/Move.anm', guid: '2222222222222222' });
  assert.match(candidate, /\{1111111111111111\}Example\/candidate\/Move\.anm/);
  assert.match(control, /\{2222222222222222\}Example\/control\/Move\.anm/);
  for (const text of [candidate, control]) assert.equal((text.match(/SourceFile "Move\.txa"/g) ?? []).length, 1);
});

test('missing, malformed, brace-wrapped and injection-shaped GUIDs fail', () => {
  for (const guid of [undefined, null, 123, '', '1234', 'G'.repeat(16), 'A'.repeat(17), '{0123456789ABCDEF}', '0123456789ABCDE\n']) {
    assert.throws(() => generateTxaImportMeta({ ...example(), guid }), /guid must contain exactly 16/);
  }
});

test('absolute, traversal, ambiguous and GUID-qualified resource paths fail before serialization', () => {
  for (const resourcePath of [
    '/Example/Move.anm', 'Q:/Example/Move.anm', 'Q:\\Example\\Move.anm', '//server/share/Move.anm',
    '../Move.anm', 'Example/../Move.anm', 'Example\\..\\Move.anm', 'Example/./Move.anm',
    'Example//Move.anm', 'Example/Move.anm/', 'Example/ Move.anm', 'Example /Move.anm',
    'Example./Move.anm', 'Example/Move.anm ', 'Example/Move.anm.',
    '{0123456789ABCDEF}Example/Move.anm', 'Example/{name}/Move.anm',
  ]) assert.throws(() => generateTxaImportMeta({ ...example(), resourcePath }), /resourcePath/);
});

test('resource and source names reject controls, syntax injection and reserved filesystem names', () => {
  for (const value of ['bad\nname.anm', 'bad\tname.anm', 'bad\0name.anm', 'bad"name.anm', 'bad:name.anm', 'bad*name.anm', 'bad?name.anm', 'bad|name.anm', '<bad>.anm', 'NUL.anm', 'CON.anm', 'aux.anm', 'LPT1.anm', 'COM9.anm']) {
    assert.throws(() => generateTxaImportMeta({ ...example(), resourcePath: `Example/${value}` }), /resourcePath/);
    assert.throws(() => generateTxaImportMeta({ ...example(), sourceFile: value.replace(/\.anm$/, '.txa') }), /sourceFile/);
  }
});

test('SourceFile accepts only a local TXA basename and never silently strips directory components', () => {
  for (const sourceFile of ['../Move.txa', 'folder/Move.txa', 'folder\\Move.txa', 'Q:/Move.txa', '/Move.txa', 'Move.anm', 'Move.txa.meta', '.txa', '']) {
    assert.throws(() => generateTxaImportMeta({ ...example(), sourceFile }), /sourceFile/);
  }
});

test('resource extension and bounded input lengths are enforced', () => {
  for (const resourcePath of [undefined, null, 42, '', 'Example/Move.txa', 'Example/Move.anm.meta', 'Example/.anm', `${'a'.repeat(256)}/Move.anm`, `${'a/'.repeat(513)}Move.anm`]) {
    assert.throws(() => generateTxaImportMeta({ ...example(), resourcePath }), /resourcePath/);
  }
  assert.throws(() => generateTxaImportMeta({ ...example(), sourceFile: `${'a'.repeat(252)}.txa` }), /sourceFile/);
});
