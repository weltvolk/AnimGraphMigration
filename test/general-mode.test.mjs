import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runGeneralCommand } from '../src/commands.mjs';
import { writeSyntheticProject, syntheticFiles } from './fixtures/synthetic-project.mjs';

const productRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.join(productRoot, 'tmp');
const generalFiles = [
  'bin/animgraph-migration-general.mjs',
  'src/project.mjs', 'src/commands.mjs', 'src/graph.mjs', 'src/resources.mjs', 'src/syntax.mjs', 'src/server.mjs',
  'web/index.html', 'assets/logo.svg', 'assets/wordmark.svg',
];
const opaqueTxa = Buffer.from('Synthetic opaque TXA: intentionally not an animation document.\n');

async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(temporaryRoot, 'general-mode-'));
  const relative = path.relative(temporaryRoot, base);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const app = path.join(base, 'standalone');
  for (const resource of generalFiles) {
    await fs.mkdir(path.dirname(path.join(app, resource)), { recursive: true });
    await fs.copyFile(path.join(productRoot, resource), path.join(app, resource));
  }
  const project = await writeSyntheticProject(path.join(base, 'source'), { 'ExampleMod/opaque.txa': opaqueTxa });
  return { ...project, base, app, output: path.join(base, 'converted'), cli: path.join(app, 'bin/animgraph-migration-general.mjs') };
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

function cli(project, args) {
  return spawnSync(process.execPath, [project.cli, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
}

async function assertOpaqueCopies(project) {
  for (const resource of ['ExampleMod/anims/Idle.anm', 'ExampleMod/anims/Move.anm', 'ExampleMod/bird.xob']) {
    assert.deepEqual(await fs.readFile(path.join(project.output, resource)), syntheticFiles[resource]);
  }
  assert.deepEqual(await fs.readFile(path.join(project.output, 'ExampleMod/opaque.txa')), opaqueTxa);
  await assert.rejects(fs.stat(path.join(project.output, '.animgraph-migration/assets.json')), { code: 'ENOENT' });
}

test('isolated general CLI migrates and verifies without any optional asset modules or profiles', async t => {
  const project = await fixture(t), before = await hashes(project.root);
  for (const resource of ['src/asset-profiles.mjs', 'src/txa-rootmotion.mjs', 'src/native-import.mjs', 'src/profiles']) {
    await assert.rejects(fs.stat(path.join(project.app, resource)), { code: 'ENOENT' });
  }
  const required = ['--root', project.root, '--workspace', project.workspace];
  const inspection = cli(project, ['inspect', ...required]);
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(JSON.parse(inspection.stdout).assignments, 2);
  assert.equal(JSON.parse(inspection.stdout).assetMigration, null);
  const conversion = cli(project, ['convert', ...required, '--output', project.output]);
  assert.equal(conversion.status, 0, conversion.stderr);
  assert.equal(JSON.parse(conversion.stdout).sourceUnchanged, true);
  const verification = cli(project, ['verify', '--root', project.output]);
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).valid, true);
  assert.deepEqual(await hashes(project.root), before);
  await assertOpaqueCopies(project);
  const repeat = cli(project, ['convert', ...required, '--output', project.output]);
  assert.equal(repeat.status, 1);
  assert.match(JSON.parse(repeat.stderr).error, /already exists/);
  for (const args of [
    ['inspect', ...required, '--asset-profile', 'anything'],
    ['convert', ...required, '--output', project.output, '--assetProfile', 'anything'],
    ['prepare-import'], ['verify-import'], ['finalize-import'],
    ['serve', '--general-only', 'false'],
  ]) {
    const rejected = cli(project, args);
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.match(rejected.stderr, /Invalid argument|Unknown command/);
    assert.doesNotMatch(rejected.stderr, /ERR_MODULE_NOT_FOUND/);
  }
  const help = cli(project, ['--help']);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /blackbird|asset-profile|prepare-import|verify-import|finalize-import/i);
});

async function serve(project) {
  const child = spawn(process.execPath, [project.cli, 'serve', '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const stopped = new Promise(resolve => child.once('close', resolve));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await stopped; };
  try {
    const url = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`General server did not emit its local session URL: ${stderr}`)), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`General server exited (${code}): ${stderr}`)); });
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = /http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/u.exec(stdout);
        if (match) { clearTimeout(timeout); resolve(new URL(match[0])); }
      });
    });
    return { origin: url.origin, token: url.hash.slice(1), stop };
  } catch (error) { await stop(); throw error; }
}

test('isolated general serve starts with a host-readable URL and blocks optional routes and fields', async t => {
  const project = await fixture(t), before = await hashes(project.root), session = await serve(project);
  const input = { root: project.root, workspace: project.workspace };
  const post = (route, body, headers = {}) => fetch(session.origin + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`, ...headers }, body: JSON.stringify(body),
  });
  try {
    const page = await fetch(session.origin);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes(session.token));
    assert.equal((await post('/api/inspect', input, { Authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await post('/api/inspect', input, { Origin: 'https://attacker.invalid' })).status, 403);
    for (const route of ['/api/prepare-import', '/api/verify-import', '/api/finalize-import']) {
      assert.equal((await post(route, {})).status, 404);
    }
    for (const [route, body] of [
      ['/api/inspect', input], ['/api/convert', { ...input, output: project.output }], ['/api/verify', { root: project.output }],
    ]) {
      for (const assetProfile of ['anything', '', null, false, {}]) {
        const rejected = await post(route, { ...body, assetProfile });
        assert.equal(rejected.status, 422);
        assert.match((await rejected.json()).error, /Invalid request fields/);
      }
    }
    assert.deepEqual((await fs.readdir(project.base)).sort(), ['source', 'standalone']);
    const inspection = await post('/api/inspect', input);
    assert.equal(inspection.status, 200);
    assert.equal((await inspection.json()).assignments, 2);
    const conversion = await post('/api/convert', { ...input, output: project.output });
    assert.equal(conversion.status, 200);
    assert.equal((await conversion.json()).sourceUnchanged, true);
    const verification = await post('/api/verify', { root: project.output });
    assert.equal(verification.status, 200);
    assert.equal((await verification.json()).valid, true);
    assert.deepEqual(await hashes(project.root), before);
    await assertOpaqueCopies(project);
  } finally { await session.stop(); }
});

test('general runner cannot activate asset modules through inherited options', async t => {
  const project = await fixture(t);
  const { runGeneralCommand: isolatedRun } = await import(pathToFileURL(path.join(project.app, 'src/commands.mjs')));
  const input = Object.assign(Object.create({ assetProfile: 'unavailable-profile' }), { root: project.root, workspace: project.workspace });
  assert.equal((await isolatedRun('inspect', input)).assignments, 2);
  await assert.rejects(runGeneralCommand('inspect', { ...input, assetProfile: undefined }), /Invalid request fields/);
  for (const command of ['prepare-import', 'verify-import', 'finalize-import', '__proto__']) {
    await assert.rejects(runGeneralCommand(command, {}), /Unknown command/);
  }
});
