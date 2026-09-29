import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AssetProfileError, listAssetProfiles, validateAssetProfile } from '../src/asset-profiles.mjs';
import { validateProfileDefinition } from '../src/internal/asset-profile-validation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

// Only invented data is used by the injected internal engine. The public API
// cannot accept this definition or substitute it for its fixed source profile.
function fixture() {
  const files = new Map([
    ['SyntheticBird/anims/Walk.anm', Buffer.from('invented compiled walk')],
    ['SyntheticBird/anims/Walk.txa', Buffer.from('invented original walk source')],
    ['SyntheticBird/anims/Idle.anm', Buffer.from('invented compiled idle')],
    ['SyntheticBird/anims/Idle.txa', Buffer.from('invented immutable idle source with trailing brace }')],
    ['SyntheticBird/config.txt', Buffer.from('unrelated copied data')],
  ]);
  const fingerprint = resource => ({ path: resource, sha256: hash(files.get(resource)) });
  const expectedBones = ['Root', 'Pelvis', ...Array.from({ length: 62 }, (_, index) => `Joint_${index}`)];
  const definition = {
    schema: 1, profileId: 'synthetic-internal-test-only', profileVersion: 1,
    rootBone: 'Root', pelvisBone: 'Pelvis', expectedBones,
    assignments: [
      { source: 'Default.Default.Walk', action: 'transform-root-motion', anm: fingerprint('SyntheticBird/anims/Walk.anm'), txa: fingerprint('SyntheticBird/anims/Walk.txa') },
      { source: 'Default.Default.Idle', action: 'copy-unchanged', anm: fingerprint('SyntheticBird/anims/Idle.anm'), txa: fingerprint('SyntheticBird/anims/Idle.txa') },
    ],
  };
  const inventory = [...files].map(([resource, bytes]) => ({ path: resource, bytes: bytes.length, sha256: hash(bytes) }));
  const activeAssignments = definition.assignments.map(job => ({ source: job.source, resource: `{0123456789ABCDEF}${job.anm.path}`, instance: 'SyntheticBird/graph.asi' }));
  return { definition, inventory, activeAssignments, files };
}

test('asset profile plans the complete synthetic inventory without mutation or runtime claims', () => {
  const input = fixture(), before = structuredClone(input);
  const result = validateProfileDefinition(input.definition, input);
  assert.deepEqual(structuredClone(input), before);
  assert.equal(result.profileId, input.definition.profileId);
  assert.equal(result.activeAssignmentCount, 2);
  assert.equal(result.requiredClipCount, 1);
  assert.equal(result.unchangedClipCount, 1);
  assert.equal(result.status, 'ready-for-txa-preparation');
  assert.equal(result.sourceProvenanceVerified, true);
  assert.equal(result.nativeImportRequired, true);
  assert.equal(result.nativeImportValidated, false);
  assert.equal(result.runtimeTestEligible, false);
  assert.equal(result.runtimeValidated, false);
  assert.deepEqual(result.expectedBones, input.definition.expectedBones);
  assert.deepEqual(result.jobs.map(job => job.action), ['transform-root-motion', 'copy-unchanged']);
  assert.equal(result.jobs[0].anm.path, 'SyntheticBird/anims/Walk.anm');
  assert.equal(result.jobs[0].txa.bytes, input.files.get('SyntheticBird/anims/Walk.txa').length);
  assert.match(result.planId, /^[a-f0-9]{64}$/);
  assert.equal(result.jobs[0].anm.sha256, hash(input.files.get('SyntheticBird/anims/Walk.anm')));
});

test('asset profile supports project inventory Maps without trusting their keys', () => {
  const input = fixture();
  const baseline = validateProfileDefinition(input.definition, input);
  const map = new Map(input.inventory.map((file, index) => [`irrelevant-key-${index}`, file]));
  assert.deepEqual(validateProfileDefinition(input.definition, { ...input, inventory: map }), baseline);
});

test('asset profile accepts equivalent case/path separators and GUIDs without changing provenance', () => {
  const input = fixture(), first = validateProfileDefinition(input.definition, input);
  const inventory = input.inventory.map(file => ({ ...file, path: file.path.toUpperCase().replaceAll('/', '\\') }));
  const activeAssignments = input.activeAssignments.map(item => ({ ...item, resource: item.resource.replace('0123456789ABCDEF', 'FEDCBA9876543210').toUpperCase() })).reverse();
  const result = validateProfileDefinition(input.definition, { inventory, activeAssignments });
  assert.equal(result.planId, first.planId);
  assert.equal(result.jobs[0].anm.path, 'SYNTHETICBIRD/ANIMS/WALK.ANM');
  assert.equal(result.jobs[0].resource, result.jobs[0].anm.path);
});

test('asset profile rejects missing, extra, duplicate or changed active assignments', () => {
  const input = fixture();
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments: input.activeAssignments.slice(1) }), /complete 2 active/);
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments: [...input.activeAssignments, { source: 'Default.Default.New', resource: 'SyntheticBird/New.anm' }] }), /complete 2 active/);
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments: [input.activeAssignments[0], input.activeAssignments[0]] }), /duplicate active/);
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments: [{ ...input.activeAssignments[0], source: 'Default.Default.Unknown' }, input.activeAssignments[1]] }), /unknown active/);
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments: [{ ...input.activeAssignments[0], resource: input.activeAssignments[1].resource }, input.activeAssignments[1]] }), /unexpected animation resource/);
});

test('asset profile rejects every missing or modified active ANM/TXA, including unchanged clips', () => {
  const input = fixture();
  for (const file of input.inventory.filter(file => /\.(anm|txa)$/u.test(file.path))) {
    assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory: input.inventory.filter(item => item.path !== file.path) }), /missing original/);
    const modified = input.inventory.map(item => item.path === file.path ? { ...item, sha256: hash('unknown changed file') } : item);
    assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory: modified }), /fingerprint mismatch/);
  }
});

test('asset profile rejects a reapplied TXA even after all migration reports were stripped', () => {
  const input = fixture();
  const transformed = Buffer.from('synthetic walk after first root conversion');
  const inventory = input.inventory.map(item => item.path.endsWith('/Walk.txa') ? { ...item, bytes: transformed.length, sha256: hash(transformed) } : item);
  assert.ok(!inventory.some(item => item.path.includes('.animgraph-migration')));
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory }), /previously transformed assets are not accepted/);
});

test('asset profile rejects existing migration markers and case-insensitive inventory collisions', () => {
  const input = fixture();
  const marker = { path: '.ANIMGRAPH-MIGRATION/report.json', bytes: 2, sha256: hash('{}') };
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory: [...input.inventory, marker] }), /migration report/);
  const duplicate = { ...input.inventory[0], path: input.inventory[0].path.toUpperCase() };
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory: [...input.inventory, duplicate] }), /collision/);
});

test('asset profile rejects unsafe paths and malformed metadata without reading the filesystem', () => {
  const input = fixture();
  for (const resource of ['../escape.anm', '/absolute.anm', 'C:/escape.anm', 'SyntheticBird/../Walk.anm', 'SyntheticBird//Walk.anm', 'SyntheticBird/NUL.anm']) {
    const activeAssignments = [{ ...input.activeAssignments[0], resource }, input.activeAssignments[1]];
    assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments }), /unsafe resource path/);
  }
  const malformedRef = [{ ...input.activeAssignments[0], resource: '{bad}SyntheticBird/anims/Walk.anm' }, input.activeAssignments[1]];
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, activeAssignments: malformedRef }), /invalid resource reference/);
  for (const override of [{ bytes: NaN }, { bytes: -1 }, { bytes: 1.5 }, { sha256: 'not-a-hash' }, { path: 'H:/absolute.txt' }]) {
    const inventory = [{ ...input.inventory[0], ...override }, ...input.inventory.slice(1)];
    assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory }), /invalid inventory|unsafe resource/);
  }
});

test('asset profile rejects malformed internal definitions and preserves error identity', () => {
  const input = fixture();
  for (const modify of [
    d => { d.schema = 2; },
    d => { d.expectedBones[1] = d.expectedBones[0]; },
    d => { d.pelvisBone = d.rootBone; },
    d => { d.assignments[0].action = 'guess'; },
    d => { d.assignments[0].txa.path = 'SyntheticBird/anims/Other.txa'; },
    d => { d.assignments[0].anm.sha256 = ''; },
    d => { d.assignments[1].source = d.assignments[0].source; },
    d => { d.assignments[1].anm = { ...d.assignments[0].anm }; d.assignments[1].txa = { ...d.assignments[0].txa }; },
  ]) {
    const definition = structuredClone(input.definition);
    modify(definition);
    assert.throws(() => validateProfileDefinition(definition, input), error => error instanceof AssetProfileError && error.profileId === input.definition.profileId);
  }
  assert.throws(() => validateProfileDefinition(input.definition, { ...input, inventory: {} }), /Map or array/);
});

test('asset profile results do not expose mutable references to the trusted definition', () => {
  const input = fixture(), first = validateProfileDefinition(input.definition, input);
  first.expectedBones[0] = 'corrupted';
  first.jobs[0].anm.sha256 = hash('corrupted');
  assert.equal(input.definition.expectedBones[0], 'Root');
  assert.equal(validateProfileDefinition(input.definition, input).jobs[0].anm.sha256, input.definition.assignments[0].anm.sha256);
});

test('public asset registry offers only the explicit original profile and has no override/force API', () => {
  const list = listAssetProfiles();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'blackbird-2.08-motion-v1');
  assert.equal(list[0].activeAssignmentCount, 37);
  assert.equal(list[0].requiredClipCount, 12);
  list[0].id = 'changed-catalog-copy';
  assert.equal(listAssetProfiles()[0].id, 'blackbird-2.08-motion-v1');
  const input = fixture();
  for (const profileId of [undefined, '', 'auto', 'blackbird64', input.definition.profileId]) assert.throws(() => validateAssetProfile({ profileId, inventory: input.inventory, activeAssignments: input.activeAssignments }), /unknown explicit profile/);
  assert.throws(() => validateAssetProfile({ profileId: 'blackbird-2.08-motion-v1', inventory: input.inventory, activeAssignments: input.activeAssignments, force: true }), /overrides and force/);
  assert.throws(() => validateAssetProfile({ profileId: 'blackbird-2.08-motion-v1', inventory: input.inventory, activeAssignments: input.activeAssignments, definition: input.definition }), /overrides and force/);
  assert.throws(() => validateAssetProfile({ profileId: 'blackbird-2.08-motion-v1', inventory: input.inventory, activeAssignments: input.activeAssignments }), /complete 37 active/);
});
