import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planMigration, convertProject, verifyProject, virtualPath } from '../src/project.mjs';
import { generateMeta, deterministicGuid } from '../src/resources.mjs';
import { writeSyntheticProject, syntheticFiles, WORKSPACE, MAIN_GRAPH } from './fixtures/synthetic-project.mjs';

async function fixture(t, overrides) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'animgraph-migration-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const output = path.join(base, 'output');
  const project = await writeSyntheticProject(source, overrides);
  return { ...project, base, source, output };
}

async function treeHashes(root) {
  const result = {};
  async function walk(relative = '') {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const resource = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(resource);
      else result[resource] = createHash('sha256').update(await fs.readFile(path.join(root, resource))).digest('hex');
    }
  }
  await walk();
  return result;
}

const readOutput = (output, resource) => fs.readFile(path.join(output, resource), 'utf8');
const cliPath = fileURLToPath(new URL('../bin/animgraph-migration.mjs', import.meta.url));
const cli = args => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });

async function updateManifestEntry(output, resource) {
  const manifestFile = path.join(output, '.animgraph-migration/manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const content = await fs.readFile(path.join(output, resource));
  const entry = manifest.files.find(item => item.path === resource);
  assert.ok(entry, `Expected manifest entry for ${resource}`);
  entry.bytes = content.length;
  entry.sha256 = createHash('sha256').update(content).digest('hex');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
}

test('inspect is read-only and describes the complete selected workspace', async t => {
  const project = await fixture(t);
  const before = await treeHashes(project.root);
  const plan = await planMigration(project);
  assert.deepEqual(await treeHashes(project.root), before);
  assert.deepEqual((await fs.readdir(project.base)).sort(), ['source']);
  assert.equal(plan.report.assignments, 2);
  assert.equal(plan.report.instances, 1);
  assert.equal(plan.report.graphFiles[0].states, 2);
  assert.equal(plan.report.graphFiles[0].transitions, 1);
  assert.equal(plan.report.graphFiles[0].sources, 2);
  assert.equal(plan.report.controls.variables, 2);
  assert.equal(plan.report.controls.commands, 1);
});

test('conversion preserves source and opaque files while producing verifiable native resources', async t => {
  const project = await fixture(t);
  const before = await treeHashes(project.root);
  const result = await convertProject(project);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.assignments, 2);
  assert.deepEqual(await treeHashes(project.root), before);
  const verified = await verifyProject({ root: project.output });
  assert.equal(verified.valid, true);
  assert.equal(verified.resources, 5);
  assert.equal(verified.workspace, WORKSPACE);
  assert.equal(await readOutput(project.output, 'ExampleMod/unused.agr'), syntheticFiles['ExampleMod/unused.agr']);
  for (const file of ['ExampleMod/anims/Idle.anm', 'ExampleMod/anims/Move.anm', 'ExampleMod/bird.xob']) {
    assert.deepEqual(await fs.readFile(path.join(project.output, file)), syntheticFiles[file]);
  }
  await assert.rejects(fs.stat(path.join(project.output, MAIN_GRAPH)), { code: 'ENOENT' });
  assert.match(await readOutput(project.output, 'ExampleMod/anims/bird_main.agf'), /AnimSrcNodeStateMachine Bird/);
  assert.match(await readOutput(project.output, 'ExampleMod/anims/bird_main.agf'), /Source "Default\.Default\.Move"/);
  assert.match(await readOutput(project.output, 'ExampleMod/anims/bird.asi'), /AnimSetInstanceSource_Line "Default\.Default\.Idle"/);
  const report = JSON.parse(await readOutput(project.output, '.animgraph-migration/report.json'));
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.resources.length, 5);
  assert.equal(new Set(report.resources.map(resource => resource.guid)).size, 5);
  assert.ok(report.resources.every(resource => !path.isAbsolute(resource.path)));
  assert.ok(!JSON.stringify(report).includes(project.base), 'Report must not expose absolute local paths');
});

test('repeated conversions generate byte-identical resources and stable GUIDs', async t => {
  const project = await fixture(t);
  const secondOutput = path.join(project.base, 'second-output');
  const first = await convertProject(project);
  const second = await convertProject({ ...project, output: secondOutput });
  assert.deepEqual(first.resources, second.resources);
  for (const resource of first.resources) {
    for (const suffix of ['', '.meta']) {
      assert.deepEqual(await fs.readFile(path.join(project.output, resource.path + suffix)), await fs.readFile(path.join(secondOutput, resource.path + suffix)));
    }
  }
});

test('BOM and CRLF text input preserves semantics', async t => {
  const overrides = Object.fromEntries(Object.entries(syntheticFiles).filter(([, value]) => typeof value === 'string').map(([name, value]) => [name, '\ufeff' + value.replaceAll('\n', '\r\n')]));
  const project = await fixture(t, overrides);
  assert.equal((await convertProject(project)).assignments, 2);
  assert.equal((await verifyProject({ root: project.output })).valid, true);
});

test('existing output is never overwritten, even when empty', async t => {
  const project = await fixture(t);
  await fs.mkdir(project.output);
  await assert.rejects(convertProject(project), /already exists/i);
  assert.deepEqual(await fs.readdir(project.output), []);
  await fs.writeFile(path.join(project.output, 'sentinel.txt'), 'keep');
  await assert.rejects(convertProject(project), /already exists/i);
  assert.equal(await readOutput(project.output, 'sentinel.txt'), 'keep');
});

test('same, descendant and ancestor output paths are rejected before writing', async t => {
  const project = await fixture(t);
  const before = await treeHashes(project.root);
  for (const output of [project.root, path.join(project.root, 'nested'), project.base]) {
    await assert.rejects(convertProject({ ...project, output }), /separate|overlap/i);
  }
  assert.deepEqual(await treeHashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('workspace traversal and absolute paths are rejected', async t => {
  const project = await fixture(t);
  for (const workspace of ['../escape.aw', '/absolute.aw', 'C:/absolute.aw', 'ExampleMod/../bird.aw', 'ExampleMod//bird.aw']) {
    await assert.rejects(planMigration({ ...project, workspace }), /unsafe|invalid/i);
  }
});

test('portable resource path rules reject Windows device names and alternate streams', () => {
  for (const resource of ['NUL', 'con.txt', 'folder/AUX.ast', 'file:stream', 'name. ', 'folder/COM1.aw', 'folder/line\nbreak.aw']) {
    assert.throws(() => virtualPath(resource), /unsafe|invalid/i);
  }
  assert.equal(virtualPath('ExampleMod\\anims\\bird.aw'), WORKSPACE);
});

test('directory links inside the source or in the output parent are rejected', async t => {
  const project = await fixture(t);
  const external = path.join(project.base, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'sentinel.txt'), 'outside');
  const sourceLink = path.join(project.source, 'linked');
  await fs.symlink(external, sourceLink, 'junction');
  await assert.rejects(planMigration(project), /symbolic|junction/i);
  await fs.unlink(sourceLink);
  const outputParentLink = path.join(project.base, 'linked-parent');
  await fs.symlink(external, outputParentLink, 'junction');
  await assert.rejects(convertProject({ ...project, output: path.join(outputParentLink, 'new-output') }), /symbolic|junction/i);
  assert.equal(await fs.readFile(path.join(external, 'sentinel.txt'), 'utf8'), 'outside');
  assert.deepEqual(await fs.readdir(external), ['sentinel.txt']);
});

test('case-only file collisions are rejected on case-sensitive filesystems', { skip: process.platform === 'win32' }, async t => {
  const project = await fixture(t, { 'ExampleMod/NOTES.txt': 'collision' });
  await assert.rejects(planMigration(project), /case-insensitive path collision/i);
});

test('unsupported field fails without source changes or partial output', async t => {
  const project = await fixture(t, { [WORKSPACE]: syntheticFiles[WORKSPACE].replace('$animWorkspace {', '$animWorkspace {\n #UnknownSetting 1') });
  const before = await treeHashes(project.root);
  await assert.rejects(convertProject(project), /unsupported field/i);
  assert.deepEqual(await treeHashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('missing resources, incorrect counts, inheritance and duplicate assignments fail visibly', async t => {
  const cases = [
    [{ 'ExampleMod/anims/Idle.anm': null }, /missing resource/i],
    [{ 'ExampleMod/anims/bird.ast': syntheticFiles['ExampleMod/anims/bird.ast'].replace('#nanims 2', '#nanims 3') }, /count/i],
    [{ 'ExampleMod/anims/bird.asi': syntheticFiles['ExampleMod/anims/bird.asi'].replace('#nparents 0', '#nparents 1') }, /inheritance/i],
    [{ 'ExampleMod/anims/bird.asi': syntheticFiles['ExampleMod/anims/bird.asi'].replace('"Move" "ExampleMod/anims/Move.anm"', '"Idle" "ExampleMod/anims/Move.anm"') }, /duplicate animation assignment/i],
    [{ 'ExampleMod/anims/bird.asi': syntheticFiles['ExampleMod/anims/bird.asi'].replace('"Move" "ExampleMod/anims/Move.anm"', '"Missing" "ExampleMod/anims/Move.anm"') }, /not declared/i],
  ];
  for (const [overrides, expected] of cases) {
    const project = await fixture(t, overrides);
    const before = await treeHashes(project.root);
    await assert.rejects(convertProject(project), expected);
    assert.deepEqual(await treeHashes(project.root), before);
    assert.deepEqual(await fs.readdir(project.base), ['source']);
  }
});

test('asset GUID disagreement is rejected before conversion', async t => {
  const clip = 'ExampleMod/anims/Idle.anm';
  const project = await fixture(t, {
    'ExampleMod/anims/bird.asi': syntheticFiles['ExampleMod/anims/bird.asi'].replace(`"${clip}"`, `"{1111111111111111}${clip}"`),
    [`${clip}.meta`]: generateMeta(clip, '2222222222222222', 'agf'),
  });
  await assert.rejects(convertProject(project), /GUID mismatch/i);
});

test('graph-selected template wins over an unrelated workspace reference with a warning', async t => {
  const project = await fixture(t, { [WORKSPACE]: syntheticFiles[WORKSPACE].replace('#animSetTemplate "ExampleMod/anims/bird.ast"', '#animSetTemplate "DZ/external.ast"') });
  const result = await convertProject(project);
  assert.ok(result.warnings.some(warning => String(warning).includes('template')));
  const output = await readOutput(project.output, WORKSPACE);
  assert.ok(!output.includes('DZ/external.ast'));
  assert.match(output, /AnimSetTemplate "\{[A-F0-9]{16}\}ExampleMod\/anims\/bird\.ast"/);
});

test('verify detects modified, missing and extra files', async t => {
  for (const mutation of ['modified', 'missing', 'extra']) {
    const project = await fixture(t);
    await convertProject(project);
    const sentinel = path.join(project.output, 'ExampleMod/notes.txt');
    if (mutation === 'modified') await fs.appendFile(sentinel, 'changed');
    if (mutation === 'missing') await fs.unlink(sentinel);
    if (mutation === 'extra') await fs.writeFile(path.join(project.output, 'extra.txt'), 'extra');
    await assert.rejects(verifyProject({ root: project.output }), /integrity|unexpected files/i);
  }
});

test('verify rejects duplicate or traversal manifest entries', async t => {
  for (const mutation of ['duplicate', 'traversal']) {
    const project = await fixture(t);
    await convertProject(project);
    const manifestFile = path.join(project.output, '.animgraph-migration/manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (mutation === 'duplicate') manifest.files.push({ ...manifest.files[0] });
    else manifest.files[0].path = '../escape';
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(verifyProject({ root: project.output }), /duplicate|unsafe/i);
  }
});

test('already migrated roots are rejected as new input', async t => {
  const project = await fixture(t);
  await convertProject(project);
  await assert.rejects(planMigration({ root: project.output, workspace: WORKSPACE }), /already contains a migration report/i);
});

test('verify checks internal reference GUIDs in addition to file hashes', async t => {
  const project = await fixture(t);
  await convertProject(project);
  const workspaceFile = path.join(project.output, WORKSPACE);
  const text = await fs.readFile(workspaceFile, 'utf8');
  const changed = text.replace(/(AnimSetTemplate "\{)[A-F0-9]{16}(\})/, (_match, before, after) => before + '1'.repeat(16) + after);
  assert.notEqual(changed, text);
  await fs.writeFile(workspaceFile, changed);
  await updateManifestEntry(project.output, WORKSPACE);
  await assert.rejects(verifyProject({ root: project.output }), /reference|GUID|metadata|template/i);
});

test('verify rejects dangling internal resource paths even when hashes match', async t => {
  const project = await fixture(t);
  await convertProject(project);
  const workspaceFile = path.join(project.output, WORKSPACE);
  const text = await fs.readFile(workspaceFile, 'utf8');
  const changed = text.replace('ExampleMod/anims/bird.ast', 'ExampleMod/anims/missing.ast');
  assert.notEqual(changed, text);
  await fs.writeFile(workspaceFile, changed);
  await updateManifestEntry(project.output, WORKSPACE);
  await assert.rejects(verifyProject({ root: project.output }), /reference|missing|metadata|template/i);
});

test('graph nodes may reference nodes declared in another graph file', async t => {
  const sourceIndex = syntheticFiles[MAIN_GRAPH].indexOf('  $Node AnimNodeSource');
  const firstGraph = syntheticFiles[MAIN_GRAPH].slice(0, sourceIndex) + ' }\n}\n';
  const secondGraph = '$AnimGraph 7 {\n $Sheet "Sources" {\n' + syntheticFiles[MAIN_GRAPH].slice(sourceIndex);
  const project = await fixture(t, {
    [MAIN_GRAPH]: firstGraph,
    'ExampleMod/anims/bird_sources.agr': secondGraph,
    'ExampleMod/anims/bird.agr': syntheticFiles['ExampleMod/anims/bird.agr'].replace('"ExampleMod/anims/bird_main.agr"', '"ExampleMod/anims/bird_main.agr"\n  "ExampleMod/anims/bird_sources.agr"'),
  });
  const result = await convertProject(project);
  assert.equal(result.graphFiles.length, 2);
  assert.equal(result.graphFiles.reduce((sum, graph) => sum + graph.sources, 0), 2);
  assert.equal((await verifyProject({ root: project.output })).valid, true);
});

test('CLI commands emit JSON and return documented success codes', async t => {
  const project = await fixture(t);
  const inspection = cli(['inspect', '--root', project.root, '--workspace', WORKSPACE]);
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(JSON.parse(inspection.stdout).assignments, 2);
  const conversion = cli(['convert', '--root', project.root, '--workspace', WORKSPACE, '--output', project.output]);
  assert.equal(conversion.status, 0, conversion.stderr);
  assert.equal(JSON.parse(conversion.stdout).sourceUnchanged, true);
  const verification = cli(['verify', '--root', project.output]);
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).valid, true);
});

test('CLI distinguishes invalid arguments from validation failures', async t => {
  const project = await fixture(t);
  for (const args of [['unknown'], ['convert', '--root', project.root], ['verify', '--root', project.root, '--force'], ['verify', '--root', project.root, '--root', project.root]]) {
    const result = cli(args);
    assert.equal(result.status, 2, result.stderr);
  }
  const failure = cli(['inspect', '--root', project.root, '--workspace', 'Missing/file.aw']);
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(JSON.parse(failure.stderr).error, /missing resource/i);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /AnimGraphMigration/);
});

test('unselected metadata cannot collide with a newly generated resource identity', async t => {
  const guid = deterministicGuid(`AnimGraphMigration:v1:${WORKSPACE.toLowerCase()}`, 'ExampleMod/anims/bird.ast');
  const project = await fixture(t, {
    'ExampleMod/unselected.ast': 'Opaque inactive synthetic resource.\n',
    'ExampleMod/unselected.ast.meta': generateMeta('ExampleMod/unselected.ast', guid, 'ast'),
  });
  await assert.rejects(convertProject(project), /GUID collision|collides/i);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('an active asset GUID remains protected when the asset has no metadata file', async t => {
  const guid = '3333333333333333';
  const clip = 'ExampleMod/anims/Idle.anm';
  const project = await fixture(t, {
    'ExampleMod/anims/bird.asi': syntheticFiles['ExampleMod/anims/bird.asi'].replace(`"${clip}"`, `"{${guid}}${clip}"`),
    [`${clip}.meta`]: null,
    'ExampleMod/unselected.ast': 'Opaque inactive synthetic resource.\n',
    'ExampleMod/unselected.ast.meta': generateMeta('ExampleMod/unselected.ast', guid, 'ast'),
  });
  const before = await treeHashes(project.root);
  await assert.rejects(convertProject(project), /collides with an active asset GUID/i);
  assert.deepEqual(await treeHashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('unselected metadata cannot claim a generated resource even using its exact name', async t => {
  const template = 'ExampleMod/anims/bird.ast';
  const guid = deterministicGuid(`AnimGraphMigration:v1:${WORKSPACE.toLowerCase()}`, template);
  const project = await fixture(t, {
    'ExampleMod/unselected.ast': 'Opaque inactive synthetic resource.\n',
    'ExampleMod/unselected.ast.meta': generateMeta(template, guid, 'ast'),
  });
  const before = await treeHashes(project.root);
  await assert.rejects(convertProject(project), /collides with a generated resource GUID/i);
  assert.deepEqual(await treeHashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('copy corruption is detected and the private staging directory is removed', async t => {
  const project = await fixture(t);
  const before = await treeHashes(project.root);
  const originalCopyFile = fs.copyFile;
  fs.copyFile = async (source, destination, ...rest) => {
    await originalCopyFile(source, destination, ...rest);
    if (path.basename(source) === 'notes.txt') await fs.appendFile(destination, 'simulated copy corruption');
  };
  try {
    await assert.rejects(convertProject(project), /copied file does not match source/i);
  } finally {
    fs.copyFile = originalCopyFile;
  }
  assert.deepEqual(await treeHashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('an output created during conversion is preserved and never replaced', async t => {
  const project = await fixture(t);
  const originalCopyFile = fs.copyFile;
  let created = false;
  fs.copyFile = async (source, destination, ...rest) => {
    await originalCopyFile(source, destination, ...rest);
    if (!created) {
      created = true;
      await fs.mkdir(project.output);
      await fs.writeFile(path.join(project.output, 'sentinel.txt'), 'belongs to another operation');
    }
  };
  try {
    await assert.rejects(convertProject(project), /output appeared|already exists/i);
  } finally {
    fs.copyFile = originalCopyFile;
  }
  assert.equal(await readOutput(project.output, 'sentinel.txt'), 'belongs to another operation');
  assert.deepEqual((await fs.readdir(project.base)).sort(), ['output', 'source']);
  assert.deepEqual(await fs.readdir(project.output), ['sentinel.txt']);
});
