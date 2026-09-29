import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planMigration, convertProject, verifyProject } from '../src/project.mjs';
import { writeSyntheticProject, syntheticFiles } from './fixtures/synthetic-project.mjs';

const temporaryRoot = fileURLToPath(new URL('../tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(temporaryRoot, 'asset-project-'));
  const relative = path.relative(temporaryRoot, base);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test cleanup must remain inside its temporary workspace');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = await writeSyntheticProject(path.join(base, 'source'));
  return { ...project, base, output: path.join(base, 'output') };
}
async function hashes(root) {
  const result = {};
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const resource = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(resource);
      else result[resource] = createHash('sha256').update(await fs.readFile(path.join(root, resource))).digest('hex');
    }
  }
  await walk();
  return result;
}

test('project inspection keeps optional asset migration disabled by default', async t => {
  const project = await fixture(t), before = await hashes(project.root);
  const plan = await planMigration(project);
  assert.equal(plan.report.assetMigration, null);
  assert.ok(!plan.converted.has('.animgraph-migration/assets.json'));
  assert.ok(![...plan.converted.keys()].some(resource => /\.(txa|anm)$/iu.test(resource)));
  assert.deepEqual(await hashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('default project conversion and verification expose null asset status and preserve opaque clips', async t => {
  const project = await fixture(t), before = await hashes(project.root);
  const result = await convertProject(project);
  assert.equal(result.assetMigration, null);
  assert.equal((await verifyProject({ root: project.output })).assetMigration, null);
  const report = JSON.parse(await fs.readFile(path.join(project.output, '.animgraph-migration/report.json'), 'utf8'));
  assert.equal(report.assetMigration, null);
  await assert.rejects(fs.stat(path.join(project.output, '.animgraph-migration/assets.json')), { code: 'ENOENT' });
  for (const resource of ['ExampleMod/anims/Idle.anm', 'ExampleMod/anims/Move.anm']) assert.deepEqual(await fs.readFile(path.join(project.output, resource)), syntheticFiles[resource]);
  assert.deepEqual(await hashes(project.root), before);
});

test('project rejects an unknown optional asset profile before creating any output', async t => {
  const project = await fixture(t), before = await hashes(project.root);
  for (const operation of [planMigration, convertProject]) await assert.rejects(operation({ ...project, assetProfile: 'unregistered-profile' }), /unknown explicit profile/);
  assert.deepEqual(await hashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('project rejects empty/non-string profile choices without silently falling back', async t => {
  const project = await fixture(t), before = await hashes(project.root);
  for (const assetProfile of ['', null, false, {}, []]) await assert.rejects(convertProject({ ...project, assetProfile }), /nonempty supported profile ID/);
  assert.deepEqual(await hashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('project refuses the real profile for an unrelated complete synthetic graph', async t => {
  const project = await fixture(t), before = await hashes(project.root);
  await assert.rejects(convertProject({ ...project, assetProfile: 'blackbird-2.08-motion-v1' }), /complete 37 active assignments/);
  assert.deepEqual(await hashes(project.root), before);
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});
