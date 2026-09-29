import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createNativeImportWorkflow, cloneImportProject } from '../src/internal/native-import-workflow.mjs';
import { prepareNativeImport as publicPrepare } from '../src/native-import.mjs';
import { migrateRootMotionTxa, ROOT_MOTION_PROFILE_ID } from '../src/txa-rootmotion.mjs';
import { validateProfileDefinition } from '../src/internal/asset-profile-validation.mjs';
import { inventoryProject, verifyProject } from '../src/project.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const reportDir = '.animgraph-migration';
const movingAnm = 'SyntheticBird/anims/Move.anm', movingTxa = 'SyntheticBird/anims/Move.txa';
const projectTemplate = `GameProjectClass {
 ID "SyntheticProject"
 Configurations {
  GameProjectConfigClass PC {
   platformHardware PC
   skeletonDefinitions "old/skeletons.xml"
   FileSystem {
    FileSystemPathClass {
     Name "old mount"
     Directory "/must-not-survive"
    }
   }
   ScriptModules {
    ScriptModulePathClass {
     Name "world"
     Paths {
      "scripts/4_World"
     }
    }
   }
  }
  GameProjectConfigClass LINUX : PC {
   platformHardware LINUX
  }
 }
}
`;

// Invented translations, joint names and native containers. No real mod files.
function sourceTxa() {
  const keys = (translations, root = false) => translations.map((t, frame) => `$frame ${frame} {
 #t ${t.join(' ')}
 ${frame === 0 ? `#q ${root ? '-0.7071068 0 0 0.7071068' : '0 0 0 1'}\n #s 0.2002 0.2002 0.2002` : ''}
}`).join('\n');
  return `$animation "invented" {
 #version 1
 #fps 30
 #numFrames 3
 $node "Scene_Root" {
  $keys t q s {
   $frame 0 2 {
   }
  }
  $node "Armature" {
   $keys t q s {
    $frame 0 2 {
     #s 0.2002 0.2002 0.2002
    }
   }
   $node "entityposition" {
    $keys t q s {
     ${keys([[0, 0, 0], [0, .5, 0], [0, 1, 0]], true)}
    }
    $node "blackbird_Pelvis_bone" {
     $keys t q s {
      ${keys([[0, .1, .2], [0, .1, .2], [0, .1, .2]])}
     }
     ${Array.from({ length: 60 }, (_, i) => `$node "Invented_${i}" {\n $keys t q s {\n $frame 0 2 {\n #t 0 0 0\n #q 0 0 0 1\n }\n }\n }`).join('\n')}
    }
   }
  }
 }
}
`;
}
function chunk(id, data) { const h = Buffer.alloc(8); h.write(id, 0, 4, 'latin1'); h.writeUInt32BE(data.length, 4); return Buffer.concat([h, data]); }
function encode(keys, dimensions, min, range) {
  const out = Buffer.alloc(keys.length * (dimensions + 1) * 2);
  keys.forEach((key, i) => {
    out.writeUInt16LE(key.frame, i * 2);
    key.value.forEach((number, axis) => out.writeUInt16LE(range ? Math.round((Math.fround(number) - min) * 65535 / range) : 0, keys.length * 2 + (i * dimensions + axis) * 2));
  });
  return out;
}
function nativeAnm(report, migrated = false) {
  const headers = [], data = [];
  for (const name of report.boneNames) {
    const field = name === report.rootBone ? (migrated ? 'newRoot' : 'originalRoot') : name === report.pelvisBone ? (migrated ? 'newPelvis' : 'originalPelvis') : null;
    const translations = field ? report.keys.map(key => ({ frame: key.frames[0], value: key[field] })) : [{ frame: 0, value: [0, 0, 0] }];
    const coordinates = translations.flatMap(key => key.value).map(Math.fround);
    const minimum = Math.min(...coordinates), range = Math.fround(Math.max(...coordinates) - minimum);
    const h = Buffer.alloc(34 + name.length);
    [minimum, range, -1, 2, 0, 1].forEach((v, i) => h.writeFloatLE(v, i * 4));
    h.writeUInt16LE(3, 24);
    [translations.length, 1, 1].forEach((v, i) => h.writeUInt16LE(v, 26 + i * 2));
    h[33] = name.length; h.write(name, 34, 'ascii'); headers.push(h);
    data.push(encode(translations, 3, minimum, range), encode([{ frame: 0, value: [1, 1, 1] }], 3, 0, 1), encode([{ frame: 0, value: [0, 0, 0, 1] }], 4, -1, 2));
  }
  const fps = Buffer.alloc(4); fps.writeUInt32LE(30);
  const body = Buffer.concat([chunk('FPS\0', fps), chunk('HEAD', Buffer.concat(headers)), chunk('DATA', Buffer.concat(data))]);
  const header = Buffer.alloc(20); header.write('FORM', 0); header.writeUInt32BE(body.length + 12, 4); header.write('ANIMSET6', 8); header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body]);
}
async function write(root, file, content) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); }
async function reseal(root) {
  const inv = await inventoryProject(root);
  await write(root, `${reportDir}/manifest.json`, json({ schema: 1, algorithm: 'SHA-256', files: [...inv.files.values()].filter(f => f.path !== `${reportDir}/manifest.json`) }));
}
async function fixture(t) {
  const temp = process.env.AGM_TEST_TMP || os.tmpdir();
  await fs.mkdir(temp, { recursive: true });
  const base = await fs.mkdtemp(path.join(temp, 'native-import-boundary-'));
  t.after(async () => { assert.equal(path.dirname(base), path.resolve(temp)); await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'prepared'), output = path.join(base, 'import'), gameRoot = path.join(base, 'game');
  await fs.mkdir(root); await fs.mkdir(gameRoot);
  const txa = sourceTxa(), migrated = migrateRootMotionTxa(txa, { source: movingTxa });
  const original = nativeAnm(migrated.report), candidate = nativeAnm(migrated.report, true);
  const files = new Map([[movingAnm, original], [movingTxa, Buffer.from(txa)], ['SyntheticBird/anims/Idle.anm', Buffer.from('invented idle ANM')], ['SyntheticBird/anims/Idle.txa', Buffer.from('untouched malformed stationary source\n}\n}\n')], ['SyntheticBird/graph.aw', Buffer.from('invented mounted workspace')], ['SyntheticBird/anims/Move.anm.meta', Buffer.from('MetaFileClass {\n Name "{ABCDEF0123456789}SyntheticBird/anims/Move.anm"\n}\n')]]);
  const fingerprint = p => ({ path: p, sha256: hash(files.get(p)) });
  const definition = { schema: 1, profileId: ROOT_MOTION_PROFILE_ID, profileVersion: 1, expectedBones: migrated.report.boneNames, rootBone: migrated.report.rootBone, pelvisBone: migrated.report.pelvisBone, assignments: [
    { source: 'Default.Default.Move', action: 'transform-root-motion', anm: fingerprint(movingAnm), txa: fingerprint(movingTxa) },
    { source: 'Default.Default.Idle', action: 'copy-unchanged', anm: fingerprint('SyntheticBird/anims/Idle.anm'), txa: fingerprint('SyntheticBird/anims/Idle.txa') },
  ] };
  const sourceInventory = [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  const sourcePlan = validateProfileDefinition(definition, { inventory: sourceInventory, activeAssignments: definition.assignments.map(j => ({ source: j.source, resource: j.anm.path })) });
  const jobs = sourcePlan.jobs.map(job => job.action === 'transform-root-motion' ? { ...job, preparedTxaSha256: hash(migrated.text), migration: migrated.report } : job);
  for (const [file, bytes] of files) await write(root, file, file === movingTxa ? migrated.text : bytes);
  await write(root, `${reportDir}/assets.json`, json({ ...sourcePlan, status: 'awaiting-native-import', jobs }));
  await write(root, `${reportDir}/report.json`, json({ resources: [], dependencies: [], workspace: 'SyntheticBird/graph.aw', warnings: [], assetMigration: { profileId: definition.profileId, planId: sourcePlan.planId, status: 'awaiting-native-import', runtimeValidation: 'not-validated' } }));
  await reseal(root);
  const template = path.join(base, 'selected.gproj'), skeleton = path.join(base, 'selected-skeletons.xml');
  await fs.writeFile(template, projectTemplate); await fs.writeFile(skeleton, '<skeletons version="1.0"><skeleton name="invented" /></skeletons>');
  const nativeProfile = { schema: 1, profileId: definition.profileId, importerBuild: 'synthetic-test-only', clips: [{ source: 'Default.Default.Move', originalAnmSha256: hash(original), originalTxaSha256: hash(txa), controlAnmSha256: hash(original) }] };
  const workflow = createNativeImportWorkflow({ definition, nativeProfile });
  const args = { root, output, projectTemplate: template, skeletonDefinitions: skeleton, gameRoot };
  const importNative = async () => { await fs.writeFile(path.join(output, 'root/AGMNativeImport/candidate/Move.anm'), candidate); };
  return { ...workflow, args, root, output, base, original, candidate, nativeProfile, definition, importNative };
}
const fingerprintTree = async root => [...(await inventoryProject(root)).files].map(([name, value]) => [name, value.sha256]);

test('isolated preparation, attested verification and fresh finalization preserve every unrelated byte', async t => {
  const f = await fixture(t), before = await fingerprintTree(f.root);
  const prepared = await f.prepareNativeImport(f.args);
  assert.equal(prepared.nativeImportRequired, true); assert.equal(prepared.runtimeTestEligible, false);
  const project = await fs.readFile(path.join(f.output, 'native-import.gproj'), 'utf8');
  assert.ok(!project.includes('/must-not-survive')); assert.match(project, /ScriptModules/); assert.match(project, /AGMNativeImport\/skeletons.anim.xml/);
  const manifest = JSON.parse(await fs.readFile(path.join(f.output, '.animgraph-native-import/manifest.json'), 'utf8'));
  assert.notEqual(manifest.jobs[0].candidate.guid, manifest.jobs[0].control.guid);
  assert.notEqual(manifest.jobs[0].candidate.guid, 'ABCDEF0123456789');
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /old ANM placeholder/);
  await f.importNative();
  const checked = await f.verifyNativeImport({ root: f.root, importRoot: f.output });
  assert.equal(checked.status, 'native-verified'); assert.equal(checked.nativeImportRequired, false); assert.equal(checked.runtimeValidation, 'not-validated');
  const final = path.join(f.base, 'final');
  const result = await f.finalizeNativeImport({ root: f.root, importRoot: f.output, output: final });
  assert.equal(result.status, 'ready-for-isolated-runtime-test'); assert.equal(result.runtimeTestEligible, true);
  assert.deepEqual(await fingerprintTree(f.root), before);
  assert.deepEqual(await fs.readFile(path.join(final, movingAnm)), f.candidate);
  for (const name of [movingTxa, 'SyntheticBird/anims/Idle.txa', 'SyntheticBird/anims/Move.anm.meta', 'SyntheticBird/graph.aw']) assert.deepEqual(await fs.readFile(path.join(final, name)), await fs.readFile(path.join(f.root, name)));
  assert.equal((await verifyProject({ root: final })).valid, true);
  await assert.rejects(fs.stat(path.join(final, 'AGMNativeImport')), { code: 'ENOENT' });
  const storedReport = await fs.readFile(path.join(final, `${reportDir}/native-import.json`), 'utf8');
  assert.ok(!storedReport.includes(f.base));
});

test('existing and overlapping outputs are rejected without changing prepared data', async t => {
  const f = await fixture(t), before = await fingerprintTree(f.root);
  await fs.mkdir(f.output); await fs.writeFile(path.join(f.output, 'sentinel'), 'keep');
  await assert.rejects(f.prepareNativeImport(f.args), /already exists/);
  assert.equal(await fs.readFile(path.join(f.output, 'sentinel'), 'utf8'), 'keep');
  await assert.rejects(f.prepareNativeImport({ ...f.args, output: path.join(f.root, 'child') }), /separate|overlap/);
  assert.deepEqual(await fingerprintTree(f.root), before);
});

test('finalization preserves structured warnings while retiring only the pending ANM warning', async t => {
  const f = await fixture(t), reportFile = path.join(f.root, `${reportDir}/report.json`);
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  const structured = { source: 'SyntheticBird/graph.aw', code: 'PREVIEW_REQUIRES_EDITOR', detail: { resource: 'SyntheticBird/model.xob' } };
  report.warnings = [structured, 'Preserve this warning.', 'Animation sources are prepared, but their ANMs still contain original release bytes.'];
  await fs.writeFile(reportFile, json(report)); await reseal(f.root);
  const before = await fingerprintTree(f.root);
  await f.prepareNativeImport(f.args); await f.importNative();
  const output = path.join(f.base, 'final');
  await f.finalizeNativeImport({ root: f.root, importRoot: f.output, output });
  const final = JSON.parse(await fs.readFile(path.join(output, `${reportDir}/report.json`), 'utf8'));
  assert.deepEqual(final.warnings[0], structured);
  assert.ok(final.warnings.includes('Preserve this warning.'));
  assert.ok(!final.warnings.some(w => typeof w === 'string' && w.includes('ANMs still contain original release bytes')));
  assert.deepEqual(await fingerprintTree(f.root), before);
  assert.equal((await verifyProject({ root: output })).valid, true);
});

test('fixed source binding rejects a resealed forged migration report', async t => {
  const f = await fixture(t), file = path.join(f.root, `${reportDir}/assets.json`), assets = JSON.parse(await fs.readFile(file, 'utf8'));
  assets.jobs[0].migration.keys[1].newPelvis[1] += .25;
  await fs.writeFile(file, json(assets)); await reseal(f.root);
  await assert.rejects(f.prepareNativeImport(f.args), /differs from the repeated transformation/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('verify and finalize reject changed mounted assets, source TXAs and metadata', async t => {
  for (const relative of ['root/SyntheticBird/graph.aw', 'root/AGMNativeImport/candidate/Move.txa', 'root/AGMNativeImport/control/Move.anm.meta']) {
    const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
    assert.equal((await f.verifyNativeImport({ root: f.root, importRoot: f.output })).runtimeTestEligible, true);
    await fs.appendFile(path.join(f.output, relative), '\nchanged');
    await assert.rejects(f.finalizeNativeImport({ root: f.root, importRoot: f.output, output: path.join(f.base, 'final') }), /Immutable import input changed/);
    await assert.rejects(fs.stat(path.join(f.base, 'final')), { code: 'ENOENT' });
  }
});

test('untrusted native hashes and extra files cannot bypass fixed control attestation', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  await fs.writeFile(path.join(f.output, 'root/AGMNativeImport/control/Move.anm'), f.candidate);
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /attested source baseline/);
  await fs.writeFile(path.join(f.output, 'root/AGMNativeImport/control/Move.anm'), f.original);
  await fs.writeFile(path.join(f.output, 'unexpected.txt'), 'not a permitted native output');
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /Unexpected or unsafe/);
});

test('finalization revalidates a native ANM changed after successful verification', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  assert.equal((await f.verifyNativeImport({ root: f.root, importRoot: f.output })).runtimeTestEligible, true);
  await fs.writeFile(path.join(f.output, 'root/AGMNativeImport/candidate/Move.anm'), f.original);
  await assert.rejects(f.finalizeNativeImport({ root: f.root, importRoot: f.output, output: path.join(f.base, 'final') }), /old ANM placeholder/);
  await assert.rejects(fs.stat(path.join(f.base, 'final')), { code: 'ENOENT' });
});

test('a newly resealed PREPARED tree cannot be substituted under an existing import', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  await fs.appendFile(path.join(f.root, 'SyntheticBird/graph.aw'), '\nchanged'); await reseal(f.root);
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /immutable PREPARED project/);
});

test('only an equivalent generated TXA alias meta is allowed; unsafe aliases fail', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  const anmMeta = path.join(f.output, 'root/AGMNativeImport/candidate/Move.anm.meta'), txaMeta = path.join(f.output, 'root/AGMNativeImport/candidate/Move.txa.meta');
  await fs.copyFile(anmMeta, txaMeta);
  assert.equal((await f.verifyNativeImport({ root: f.root, importRoot: f.output })).generatedMetas.length, 1);
  await fs.writeFile(txaMeta, (await fs.readFile(anmMeta, 'utf8')).replace('Move.txa', '../outside.txa'));
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /Unexpected or unsafe/);
});

test('native formatting normalization is accepted only for import metas and records both immutable fingerprints', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  const manifestPath = path.join(f.output, '.animgraph-native-import/manifest.json');
  const initialManifest = await fs.readFile(manifestPath);
  const rewritten = [];
  for (const kind of ['candidate', 'control']) {
    const file = path.join(f.output, `root/AGMNativeImport/${kind}/Move.anm.meta`);
    const before = await fs.readFile(file, 'utf8');
    const after = '// native formatting\r\n' + before.trimEnd().replace(/^ +/gm, indent => indent + indent).replaceAll('\n', '\r\n');
    await fs.writeFile(file, after);
    rewritten.push({ before, after });
  }
  const checked = await f.verifyNativeImport({ root: f.root, importRoot: f.output });
  assert.equal(checked.normalizedMetas.length, 2);
  for (let i = 0; i < rewritten.length; i++) {
    const recorded = checked.normalizedMetas[i], { before, after } = rewritten[i];
    assert.equal(recorded.preparedSha256, hash(before)); assert.equal(recorded.nativeSha256, hash(after));
    assert.equal(recorded.preparedBytes, Buffer.byteLength(before)); assert.equal(recorded.nativeBytes, Buffer.byteLength(after));
  }
  assert.deepEqual(await fs.readFile(manifestPath), initialManifest);
  const final = path.join(f.base, 'final');
  await f.finalizeNativeImport({ root: f.root, importRoot: f.output, output: final });
  const validation = JSON.parse(await fs.readFile(path.join(final, `${reportDir}/native-import.json`), 'utf8'));
  assert.deepEqual(validation.normalizedMetas, checked.normalizedMetas);
  assert.deepEqual(await fs.readFile(path.join(final, 'SyntheticBird/anims/Move.anm.meta')), await fs.readFile(path.join(f.root, 'SyntheticBird/anims/Move.anm.meta')));
});

test('GUID, resource, source file, platform inheritance and extra field changes are not formatting', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  const file = path.join(f.output, 'root/AGMNativeImport/control/Move.anm.meta'), original = await fs.readFile(file, 'utf8');
  const changes = [
    text => text.replace(/\{[A-F0-9]{16}\}/, '{0000000000000000}'),
    text => text.replace('AGMNativeImport/control/Move.anm', 'AGMNativeImport/candidate/Move.anm'),
    text => text.replace('SourceFile "Move.txa"', 'SourceFile "Other.txa"'),
    text => text.replace('TXAResourceClass XBOX_ONE : PC', 'TXAResourceClass XBOX_ONE : LINUX'),
    text => text.replace('TXAResourceClass PS4 : PC', 'TXAResourceClass PS5 : PC'),
    text => text.replace('SourceFile "Move.txa"', 'SourceFile "Move.txa"\n   Unexpected 1'),
  ];
  for (const alter of changes) {
    await fs.writeFile(file, alter(original));
    await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /Immutable import input changed/);
  }
  await fs.writeFile(file, original);
  // Metadata copied from PREPARED is outside the narrow native-meta exception.
  await fs.appendFile(path.join(f.output, 'root/SyntheticBird/anims/Move.anm.meta'), '\n');
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /Immutable import input changed/);
});

test('source or import links are rejected without modifying link targets', async t => {
  const f = await fixture(t); await f.prepareNativeImport(f.args); await f.importNative();
  const alias = path.join(f.base, 'source-alias');
  try { await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not allow creating a test link'); return; } throw error; }
  await assert.rejects(f.verifyNativeImport({ root: alias, importRoot: f.output }), /links\/junctions/);
  const linked = path.join(f.output, 'root/AGMNativeImport/candidate/link.anm');
  await fs.link(path.join(f.root, movingAnm), linked);
  await assert.rejects(f.verifyNativeImport({ root: f.root, importRoot: f.output }), /Hard links/);
  assert.deepEqual(await fs.readFile(path.join(f.root, movingAnm)), f.original);
});

test('project mounts are cloned structurally and ambiguous configurations fail', () => {
  const converted = cloneImportProject(projectTemplate, { importMount: '/isolated/root', gameRoot: '/selected/game', skeletonResource: 'AGMNativeImport/skeletons.anim.xml' });
  assert.ok(!converted.includes('/must-not-survive')); assert.match(converted, /SyntheticProject/); assert.match(converted, /scripts\/4_World/);
  assert.throws(() => cloneImportProject(projectTemplate.replace('platformHardware PC', 'FileSystem {\n}\n platformHardware PC'), { importMount: '/one', gameRoot: '/two', skeletonResource: 'safe/file.xml' }), /Ambiguous/);
});

test('public API cannot inject a synthetic definition, trusted digest or force flag', async () => {
  for (const extra of ['definition', 'nativeProfile', 'expectedControlSha256', 'force']) await assert.rejects(publicPrepare({ root: 'x', output: 'y', projectTemplate: 'z', skeletonDefinitions: 's', gameRoot: 'g', [extra]: true }), /Unknown native-import option/);
});
