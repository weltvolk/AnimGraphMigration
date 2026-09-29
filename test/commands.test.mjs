import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COMMAND_SCHEMAS, validateCommandInput, runCommand } from '../src/commands.mjs';
import { writeSyntheticProject } from './fixtures/synthetic-project.mjs';

const cliPath = fileURLToPath(new URL('../bin/animgraph-migration.mjs', import.meta.url));
const temporaryRoot = fileURLToPath(new URL('../tmp/', import.meta.url));
const cli = args => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(temporaryRoot, 'commands-'));
  const relative = path.relative(temporaryRoot, base);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = await writeSyntheticProject(path.join(base, 'source'));
  return { ...project, base, output: path.join(base, 'converted') };
}

const nativeInputs = {
  'prepare-import': { root: 'prepared', output: 'import', projectTemplate: 'example.gproj', skeletonDefinitions: 'skeletons.anim.xml', gameRoot: 'game' },
  'verify-import': { root: 'prepared', importRoot: 'import' },
  'finalize-import': { root: 'prepared', importRoot: 'import', output: 'final' },
};

test('commands leave assetProfile optional for inspect/convert and reject it elsewhere', () => {
  for (const [command, minimal] of [['inspect', { root: 'source', workspace: 'Example/bird.aw' }], ['convert', { root: 'source', workspace: 'Example/bird.aw', output: 'new' }]]) {
    assert.equal(validateCommandInput(command, minimal), minimal);
    const profiled = { ...minimal, assetProfile: 'blackbird-2.08-motion-v1' };
    assert.equal(validateCommandInput(command, profiled), profiled);
    for (const value of ['', null, false, {}, []]) assert.throws(() => validateCommandInput(command, { ...minimal, assetProfile: value }), /Invalid request fields/);
  }
  assert.throws(() => validateCommandInput('verify', { root: 'prepared', assetProfile: 'blackbird-2.08-motion-v1' }), /Invalid request fields/);
});

test('every native command requires each specified field and accepts only nonempty string values', () => {
  for (const [command, input] of Object.entries(nativeInputs)) {
    assert.equal(validateCommandInput(command, input), input);
    assert.deepEqual(Object.keys(input).sort(), [...COMMAND_SCHEMAS[command].required].sort());
    for (const key of Object.keys(input)) {
      const missing = { ...input };
      delete missing[key];
      assert.throws(() => validateCommandInput(command, missing), /Invalid request fields/, `${command} requires ${key}`);
      for (const value of ['', undefined, null, 7, false, [], {}]) assert.throws(() => validateCommandInput(command, { ...input, [key]: value }), /Invalid request fields/);
    }
  }
});

test('native command schemas cannot receive caller-supplied controls, trust records or force flags', () => {
  for (const [command, input] of Object.entries(nativeInputs)) {
    for (const key of ['controls', 'expectedControlSha256', 'trustedDigests', 'controlEvidence', 'runtimeTestEligible', 'nativeImportValidated', 'assetProfile', 'force', '__proto__']) {
      const smuggled = Object.fromEntries([...Object.entries(input), [key, 'caller-supplied']]);
      assert.throws(() => validateCommandInput(command, smuggled), /Invalid request fields/, `${command} must reject ${key}`);
    }
  }
});

test('command validation rejects unknown commands, primitives and inherited required fields', () => {
  for (const command of ['unknown', 'constructor', 'toString', '__proto__']) assert.throws(() => validateCommandInput(command, {}), /Unknown command/);
  for (const input of [null, [], 'input', 42, false]) assert.throws(() => validateCommandInput('verify', input), /Invalid request fields/);
  const inherited = Object.create({ root: 'inherited' });
  assert.throws(() => validateCommandInput('verify', inherited), /Invalid request fields/);
});

test('default command dispatch still inspects, converts and verifies a synthetic graph', async t => {
  const project = await fixture(t);
  const input = { root: project.root, workspace: project.workspace };
  const inspect = await runCommand('inspect', input);
  assert.equal(inspect.assignments, 2);
  assert.equal(inspect.assetMigration, null);
  const converted = await runCommand('convert', { ...input, output: project.output });
  assert.equal(converted.sourceUnchanged, true);
  assert.equal(converted.assetMigration, null);
  const verified = await runCommand('verify', { root: project.output });
  assert.equal(verified.valid, true);
  assert.equal(verified.assetMigration, null);
});

test('CLI maps optional --asset-profile to the domain validator without making it mandatory', async t => {
  const project = await fixture(t), required = ['--root', project.root, '--workspace', project.workspace];
  const regular = cli(['inspect', ...required]);
  assert.equal(regular.status, 0, regular.stderr);
  assert.equal(JSON.parse(regular.stdout).assetMigration, null);
  const unknown = cli(['inspect', ...required, '--asset-profile', 'unsupported-profile']);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(JSON.parse(unknown.stderr).error, /unknown explicit profile.*unsupported-profile/);
  const graphOnlyOutput = cli(['convert', ...required, '--output', project.output]);
  assert.equal(graphOnlyOutput.status, 0, graphOnlyOutput.stderr);
  assert.equal(JSON.parse(graphOnlyOutput.stdout).assetMigration, null);
});

test('CLI rejects duplicate optional flags, camelCase aliases and missing option values', async t => {
  const project = await fixture(t), required = ['--root', project.root, '--workspace', project.workspace];
  for (const rest of [
    ['--asset-profile', 'one', '--asset-profile', 'two'],
    ['--assetProfile', 'one'],
    ['--asset-profile'],
    ['--asset-profile', '--output', 'elsewhere'],
    ['--force', 'true'],
  ]) {
    const result = cli(['inspect', ...required, ...rest]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Invalid argument/);
  }
  assert.deepEqual(await fs.readdir(project.base), ['source']);
});

test('CLI checks native kebab-case required fields and duplicates before loading native modules', () => {
  const flag = name => '--' + name.replace(/[A-Z]/g, character => '-' + character.toLowerCase());
  for (const [command, input] of Object.entries(nativeInputs)) {
    const complete = Object.entries(input).flatMap(([name, value]) => [flag(name), value]);
    for (const missing of Object.keys(input)) {
      const args = Object.entries(input).filter(([name]) => name !== missing).flatMap(([name, value]) => [flag(name), value]);
      const result = cli([command, ...args]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(`Missing ${flag(missing)}`));
    }
    for (const name of Object.keys(input)) {
      const result = cli([command, ...complete, flag(name), 'duplicate']);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(`Invalid argument: ${flag(name)}`));
    }
    const unexpected = cli([command, ...complete, '--expected-control-sha256', '0'.repeat(64)]);
    assert.equal(unexpected.status, 2, unexpected.stderr);
    assert.match(unexpected.stderr, /Invalid argument: --expected-control-sha256/);
  }
});

test('CLI help lists the manual native import steps without executing them', () => {
  const result = cli(['--help']);
  assert.equal(result.status, 0);
  for (const command of Object.keys(nativeInputs)) assert.ok(result.stdout.includes(command));
  for (const flag of ['--project-template', '--skeleton-definitions', '--game-root', '--import-root']) assert.ok(result.stdout.includes(flag));
  assert.match(result.stdout, /Workbench import/);
});
