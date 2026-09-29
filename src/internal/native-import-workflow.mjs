import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inventoryProject, assertNoLinks, hashFile, verifyProject, virtualPath, relatedProjectPaths, REPORT_DIRECTORY } from '../project.mjs';
import { validateProfileDefinition } from './asset-profile-validation.mjs';
import { restoreOriginalTxa } from '../txa-rootmotion.mjs';
import { generateTxaImportMeta } from '../native-import-resources.mjs';
import { validateNativeAnimation } from '../native-animation-check.mjs';
import { deterministicGuid } from '../resources.mjs';
import { parseDocument, serialize, values } from '../syntax.mjs';

const MOUNT = 'root', NAMESPACE = 'AGMNativeImport';
const IMPORT_MANIFEST = '.animgraph-native-import/manifest.json';
const PROJECT = 'native-import.gproj';
const SKELETON = `${MOUNT}/${NAMESPACE}/skeletons.anim.xml`;
const PREPARED_MANIFEST = `${REPORT_DIRECTORY}/manifest.json`;
const REPORT = `${REPORT_DIRECTORY}/report.json`, ASSETS = `${REPORT_DIRECTORY}/assets.json`;
const VALIDATION = `${REPORT_DIRECTORY}/native-import.json`;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const token = (value, quoted = false) => ({ value, quoted });
const field = (name, value) => ({ head: [token(name), token(value, true)], children: null });
const block = (name, children) => ({ head: [token(name)], children });
const named = (entry, name) => (entry.children ?? []).filter(item => values(item)[0] === name);
const overlap = (a, b) => relatedProjectPaths(a, b) || relatedProjectPaths(b, a);
const comparable = entries => entries.map(e => ({ head: values(e), children: e.children === null ? null : comparable(e.children) }));
const utf8 = buffer => {
  if (buffer.includes(0)) throw new Error('Binary/UTF-16 text input is not supported');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
};
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function options(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an options object');
  for (const key of Object.keys(value)) if (!required.includes(key)) throw new Error(`Unknown native-import option: ${key}`);
  for (const key of required) if (typeof value[key] !== 'string' || !value[key] || value[key].includes('\0')) throw new Error(`Native import requires ${key}`);
}
function sameInventory(a, b, label) {
  if (a.files.size !== b.files.size || [...a.files].some(([key, file]) => b.files.get(key)?.sha256 !== file.sha256 || b.files.get(key)?.bytes !== file.bytes)) throw new Error(`${label} changed during native import; no result accepted`);
}
async function inventory(root) {
  const inv = await inventoryProject(root);
  // A newly introduced hard link must not let Workbench writes reach another tree.
  for (const file of inv.files.values()) if ((await fs.stat(path.join(inv.root, file.path))).nlink > 1) throw new Error(`Hard links are not accepted: ${file.path}`);
  return inv;
}
async function read(inv, resource, maximum = 32 * 1024 * 1024) {
  const name = virtualPath(resource), item = inv.files.get(name.toLowerCase());
  if (!item || item.bytes > maximum) throw new Error(`Missing or oversized input: ${name}`);
  const bytes = await fs.readFile(path.join(inv.root, item.path));
  if (sha(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`Input changed while reading: ${name}`);
  return bytes;
}
const readJson = async (inv, resource) => JSON.parse(utf8(await read(inv, resource)));
async function inputFile(file) {
  await assertNoLinks(file);
  const real = await fs.realpath(file), stat = await fs.stat(real);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > 32 * 1024 * 1024) throw new Error('Expected a regular, unlinked input file no larger than 32 MiB');
  const bytes = await fs.readFile(real);
  return { real, bytes, sha256: sha(bytes) };
}
async function directory(file) {
  await assertNoLinks(file);
  const real = await fs.realpath(file);
  if (!(await fs.stat(real)).isDirectory()) throw new Error('Expected a directory');
  return real;
}
async function newOutput(value, inputs) {
  await assertNoLinks(value);
  if (await exists(value)) throw new Error('Output already exists; choose a new directory. Nothing overwritten.');
  let parent = path.resolve(value), tail = [];
  while (!(await exists(parent))) { tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const output = path.join(await fs.realpath(parent), ...tail);
  if (inputs.some(input => overlap(output, input))) throw new Error('Output must be separate from every input; overlapping paths are not accepted');
  return output;
}
async function put(root, name, bytes) {
  const file = path.join(root, virtualPath(name));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: 'wx' });
}
async function copyInventory(inv, destination, prefix = '') {
  for (const file of inv.files.values()) {
    const relative = prefix ? `${prefix}/${file.path}` : file.path;
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(inv.root, file.path), target, fs.constants.COPYFILE_EXCL);
  }
}
async function transaction(output, action) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await assertNoLinks(path.dirname(output));
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.native-import-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    const result = await action(staging);
    await assertNoLinks(output);
    if (await exists(output)) throw new Error('Output appeared during native import; nothing overwritten');
    await fs.rename(staging, output);
    return { ...result, output };
  } catch (error) {
    // Only this random, exclusively created sibling may be removed.
    if (path.dirname(staging) === path.dirname(output) && path.basename(staging).startsWith(`.${path.basename(output)}.native-import-`)) {
      await assertNoLinks(staging);
      await fs.rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Pure project cloning. FileSystem roots are replaced structurally, never by text substitution. */
export function cloneImportProject(text, { importMount, gameRoot, skeletonResource }) {
  const entries = parseDocument(text, { source: 'selected project template' });
  if (entries.length !== 1 || values(entries[0])[0] !== 'GameProjectClass' || !entries[0].children) throw new Error('Expected exactly one GameProjectClass template');
  const configs = named(entries[0], 'Configurations');
  if (configs.length !== 1 || !configs[0].children) throw new Error('Project template requires one Configurations block');
  const pcs = configs[0].children.filter(e => values(e)[0] === 'GameProjectConfigClass' && values(e)[1] === 'PC');
  if (pcs.length !== 1 || !pcs[0].children) throw new Error('Project template requires exactly one PC configuration');
  const mounts = () => block('FileSystem', [
    block('FileSystemPathClass', [field('Name', 'Isolated native animation import'), field('Directory', importMount.replaceAll('\\', '/'))]),
    block('FileSystemPathClass', [field('Name', 'Explicit game root'), field('Directory', gameRoot.replaceAll('\\', '/'))]),
  ]);
  const seen = new Set();
  for (const config of configs[0].children) {
    if (values(config)[0] !== 'GameProjectConfigClass' || !config.children) throw new Error('Unsupported project configuration entry');
    const platform = values(config)[1];
    if (!platform || seen.has(platform)) throw new Error('Duplicate or missing project platform');
    seen.add(platform);
    if (named(config, 'FileSystem').length > 1) throw new Error('Ambiguous project FileSystem blocks');
    const hadFileSystem = named(config, 'FileSystem').length;
    config.children = config.children.filter(e => values(e)[0] !== 'FileSystem');
    if (platform === 'PC') {
      if (named(config, 'skeletonDefinitions').length > 1) throw new Error('Ambiguous skeletonDefinitions');
      config.children = config.children.filter(e => values(e)[0] !== 'skeletonDefinitions');
      config.children.push(field('skeletonDefinitions', virtualPath(skeletonResource)), mounts());
    } else if (hadFileSystem) config.children.push(mounts());
  }
  const allowed = new Set(configs[0].children.flatMap(config => named(config, 'FileSystem')));
  const visit = list => { for (const e of list) { if (values(e)[0] === 'FileSystem' && !allowed.has(e)) throw new Error('Unsupported nested FileSystem mount'); if (e.children) visit(e.children); } };
  visit(entries);
  return serialize(entries);
}

/** Internal constructor only: public APIs never accept profile or validator overrides. */
export function createNativeImportWorkflow({ definition, nativeProfile }) {
  // Keep attestations private to this instance even if another module retains
  // the JSON object it supplied to this internal constructor.
  definition = structuredClone(definition);
  nativeProfile = structuredClone(nativeProfile);
  const expected = new Map(definition.assignments.map(job => [job.source, job]));
  const controls = new Map(nativeProfile.clips.map(job => [job.source, job]));
  const moving = definition.assignments.filter(job => job.action === 'transform-root-motion');
  if (nativeProfile.schema !== 1 || nativeProfile.profileId !== definition.profileId || typeof nativeProfile.importerBuild !== 'string' || controls.size !== moving.length || nativeProfile.clips.length !== moving.length) throw new Error('Invalid trusted native import registry');
  for (const job of moving) {
    const control = controls.get(job.source);
    if (!control || control.originalAnmSha256 !== job.anm.sha256 || control.originalTxaSha256 !== job.txa.sha256 || !/^[a-f0-9]{64}$/.test(control.controlAnmSha256)) throw new Error('Native control registry is not bound to the original source fingerprints');
  }

  async function prepared(root) {
    await verifyProject({ root });
    const inv = await inventory(root), report = await readJson(inv, REPORT), assets = await readJson(inv, ASSETS);
    if (report.assetMigration?.status !== 'awaiting-native-import' || assets.status !== 'awaiting-native-import') throw new Error('Native import requires an immutable PREPARED project awaiting native import');
    if (report.assetMigration.profileId !== definition.profileId || assets.profileId !== definition.profileId || assets.profileVersion !== definition.profileVersion) throw new Error('Unsupported PREPARED asset profile');
    if (!Array.isArray(assets.jobs) || assets.jobs.length !== expected.size || !isDeepStrictEqual(assets.expectedBones, definition.expectedBones)) throw new Error('PREPARED asset inventory or bone profile differs from the trusted registry');
    const originalInventory = new Map([...inv.files].filter(([key]) => !key.startsWith(`${REPORT_DIRECTORY}/`)));
    const jobs = [], assigned = new Set();
    for (const job of assets.jobs) {
      const trusted = expected.get(job.source);
      if (!trusted || assigned.has(job.source) || job.action !== trusted.action) throw new Error('Unknown, duplicate or changed PREPARED animation job');
      assigned.add(job.source);
      for (const kind of ['anm', 'txa']) if (typeof job[kind]?.path !== 'string' || job[kind].path.toLowerCase() !== trusted[kind].path.toLowerCase() || job[kind].sha256 !== trusted[kind].sha256) throw new Error(`PREPARED source provenance differs from fixed registry: ${job.source}`);
      if (inv.files.get(job.anm.path.toLowerCase())?.sha256 !== trusted.anm.sha256) throw new Error(`PREPARED original ANM placeholder changed: ${job.anm.path}`);
      if (job.action === 'copy-unchanged') {
        if (job.migration || inv.files.get(job.txa.path.toLowerCase())?.sha256 !== trusted.txa.sha256) throw new Error(`Unchanged clip was modified: ${job.txa.path}`);
        continue;
      }
      const candidateText = utf8(await read(inv, job.txa.path, 8 * 1024 * 1024));
      if (sha(candidateText) !== job.preparedTxaSha256 || job.migration?.sourceSha256 !== trusted.txa.sha256 || !isDeepStrictEqual(job.migration.boneNames, definition.expectedBones)) throw new Error(`Prepared TXA or migration report differs from source binding: ${job.txa.path}`);
      const originalText = restoreOriginalTxa(candidateText, job.migration);
      if (sha(originalText) !== trusted.txa.sha256 || Buffer.byteLength(originalText) !== job.txa.bytes) throw new Error(`Restored control TXA differs from fixed original fingerprint: ${job.txa.path}`);
      originalInventory.set(job.txa.path.toLowerCase(), { path: job.txa.path, sha256: sha(originalText), bytes: Buffer.byteLength(originalText) });
      jobs.push({ ...job, originalText, candidateText });
    }
    const sourcePlan = validateProfileDefinition(definition, { inventory: originalInventory, activeAssignments: assets.jobs.map(job => ({ source: job.source, resource: job.anm.path })) });
    if (jobs.length !== moving.length || assets.requiredClipCount !== moving.length || assets.planId !== sourcePlan.planId || report.assetMigration.planId !== sourcePlan.planId) throw new Error('PREPARED plan identity or complete clip count mismatch');
    if (inv.names.has(NAMESPACE.toLowerCase())) throw new Error('Prepared project collides with reserved native import namespace');
    return { inv, report, assets, jobs, planId: sourcePlan.planId, manifestSha256: inv.files.get(PREPARED_MANIFEST).sha256 };
  }
  function importJobs(prep) {
    const used = new Set(), filenames = new Set();
    return prep.jobs.map(job => {
      const stem = path.posix.basename(job.anm.path.replaceAll('\\', '/')).slice(0, -4);
      if (filenames.has(stem.toLowerCase())) throw new Error('Native import basenames collide');
      filenames.add(stem.toLowerCase());
      const result = { source: job.source, originalAnm: job.anm.path, originalTxa: job.txa.path };
      for (const kind of ['candidate', 'control']) {
        const resource = `${NAMESPACE}/${kind}/${stem}.anm`;
        const guid = deterministicGuid(`AnimGraphMigration:native:${prep.planId}`, resource);
        if (used.has(guid)) throw new Error('Native import GUID collision');
        used.add(guid);
        result[kind] = { guid, resource, anm: `${MOUNT}/${resource}`, txa: `${MOUNT}/${resource.slice(0, -4)}.txa`, meta: `${MOUNT}/${resource}.meta` };
      }
      return result;
    });
  }
  function meta(job, kind) { return generateTxaImportMeta({ resourcePath: job[kind].resource, guid: job[kind].guid }); }
  async function immutablePrepared(prep) { sameInventory(prep.inv, await inventory(prep.inv.root), 'PREPARED project'); }

  async function prepareNativeImport(args) {
    options(args, ['root', 'output', 'projectTemplate', 'skeletonDefinitions', 'gameRoot']);
    const prep = await prepared(args.root);
    const [template, skeleton, game] = await Promise.all([inputFile(args.projectTemplate), inputFile(args.skeletonDefinitions), directory(args.gameRoot)]);
    const output = await newOutput(args.output, [prep.inv.root, template.real, skeleton.real, game]);
    const jobs = importJobs(prep), projectText = cloneImportProject(utf8(template.bytes), { importMount: path.join(output, MOUNT), gameRoot: game, skeletonResource: `${NAMESPACE}/skeletons.anim.xml` });
    const skeletonText = utf8(skeleton.bytes);
    if (!/<skeletons(?:\s|>)/.test(skeletonText) || /<!DOCTYPE|<!ENTITY/i.test(skeletonText)) throw new Error('Expected a supplied skeletons XML registry without external entities');
    const newIds = new Set(jobs.flatMap(job => [job.candidate.guid, job.control.guid]));
    for (const file of prep.inv.files.values()) if (file.path.toLowerCase().endsWith('.meta')) {
      for (const match of utf8(await read(prep.inv, file.path)).matchAll(/\{([a-f0-9]{16})\}/ig)) if (newIds.has(match[1].toUpperCase())) throw new Error('Native import GUID collides with a prepared asset');
    }
    return transaction(output, async staging => {
      await copyInventory(prep.inv, staging, MOUNT);
      for (let i = 0; i < jobs.length; i++) for (const kind of ['candidate', 'control']) {
        await put(staging, jobs[i][kind].txa, kind === 'candidate' ? prep.jobs[i].candidateText : prep.jobs[i].originalText);
        await put(staging, jobs[i][kind].anm, await read(prep.inv, prep.jobs[i].anm.path));
        await put(staging, jobs[i][kind].meta, meta(jobs[i], kind));
      }
      await put(staging, PROJECT, projectText);
      await put(staging, SKELETON, skeleton.bytes);
      const staged = await inventory(staging);
      for (const file of prep.inv.files.values()) if (staged.files.get(`${MOUNT}/${file.path}`.toLowerCase())?.sha256 !== file.sha256) throw new Error(`Prepared copy changed: ${file.path}`);
      const manifest = {
        schema: 1, profileId: definition.profileId, importerBuild: nativeProfile.importerBuild, planId: prep.planId,
        preparedManifestSha256: prep.manifestSha256, project: PROJECT, mount: MOUNT, namespace: NAMESPACE,
        status: 'awaiting-native-import', runtimeValidation: 'not-validated',
        selectedInputs: { projectTemplateSha256: template.sha256, skeletonDefinitionsSha256: skeleton.sha256 },
        jobs, mutableAnms: jobs.flatMap(job => [job.candidate.anm, job.control.anm]),
        files: [...staged.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      };
      await put(staging, IMPORT_MANIFEST, json(manifest));
      await immutablePrepared(prep);
      for (const input of [template, skeleton]) if (await hashFile(input.real) !== input.sha256) throw new Error('Selected import input changed during preparation');
      await assertNoLinks(game);
      return { status: 'awaiting-native-import', profileId: definition.profileId, importerBuild: nativeProfile.importerBuild, project: PROJECT, rebuildFolder: `${MOUNT}/${NAMESPACE}`, candidateCount: jobs.length, controlCount: jobs.length, preparedManifestSha256: prep.manifestSha256, nativeImportRequired: true, nativeImportValidated: false, runtimeTestEligible: false, runtimeValidation: 'not-validated', instructions: `Open ${PROJECT} in Experimental Workbench build ${nativeProfile.importerBuild}; rebuild ONLY ${MOUNT}/${NAMESPACE}/candidate and ${MOUNT}/${NAMESPACE}/control. Preserve all other files. Then verify the native import.` };
    });
  }

  async function checkImport(root, importRoot) {
    const prep = await prepared(root), inv = await inventory(importRoot);
    if (overlap(prep.inv.root, inv.root)) throw new Error('PREPARED and import directories must be separate');
    const manifest = await readJson(inv, IMPORT_MANIFEST), jobs = importJobs(prep);
    if (manifest.schema !== 1 || manifest.profileId !== definition.profileId || manifest.importerBuild !== nativeProfile.importerBuild || manifest.planId !== prep.planId || manifest.preparedManifestSha256 !== prep.manifestSha256 || manifest.project !== PROJECT || manifest.mount !== MOUNT || manifest.namespace !== NAMESPACE || !isDeepStrictEqual(manifest.jobs, jobs)) throw new Error('Native import manifest does not match the immutable PREPARED project and fixed profile');
    const mutable = jobs.flatMap(job => [job.candidate.anm, job.control.anm]);
    if (!isDeepStrictEqual(manifest.mutableAnms, mutable) || !Array.isArray(manifest.files)) throw new Error('Unexpected mutable native import resources');
    const expectedFiles = new Map();
    const addExpected = (name, hash, bytes) => { const key = virtualPath(name).toLowerCase(); if (expectedFiles.has(key)) throw new Error('Duplicate expected native import file'); expectedFiles.set(key, { path: name, sha256: hash, bytes }); };
    for (const file of prep.inv.files.values()) addExpected(`${MOUNT}/${file.path}`, file.sha256, file.bytes);
    for (let i = 0; i < jobs.length; i++) for (const kind of ['candidate', 'control']) {
      const text = kind === 'candidate' ? prep.jobs[i].candidateText : prep.jobs[i].originalText;
      addExpected(jobs[i][kind].txa, sha(text), Buffer.byteLength(text));
      const metadata = meta(jobs[i], kind);
      addExpected(jobs[i][kind].meta, sha(metadata), Buffer.byteLength(metadata));
      addExpected(jobs[i][kind].anm, prep.jobs[i].anm.sha256, prep.jobs[i].anm.bytes);
    }
    for (const name of [PROJECT, SKELETON]) {
      const entries = manifest.files.filter(file => file.path === name);
      if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256) || !Number.isSafeInteger(entries[0].bytes)) throw new Error('Invalid pinned project/skeleton input');
      addExpected(name, entries[0].sha256, entries[0].bytes);
    }
    if (expectedFiles.get(SKELETON.toLowerCase()).sha256 !== manifest.selectedInputs?.skeletonDefinitionsSha256) throw new Error('Skeleton input fingerprint binding mismatch');
    const listed = new Set();
    for (const entry of manifest.files) {
      const key = virtualPath(entry.path).toLowerCase(), expectedFile = expectedFiles.get(key);
      if (listed.has(key) || !expectedFile || expectedFile.sha256 !== entry.sha256 || expectedFile.bytes !== entry.bytes) throw new Error('Import manifest file inventory differs from the immutable preparation');
      listed.add(key);
    }
    if (listed.size !== expectedFiles.size) throw new Error('Incomplete import manifest');
    const mutableSet = new Set(mutable.map(name => name.toLowerCase()));
    const importMetas = new Map(jobs.flatMap(job => ['candidate', 'control'].map(kind => [job[kind].meta.toLowerCase(), { job, kind }])));
    const normalizedMetas = [];
    for (const [key, entry] of expectedFiles) {
      const actual = inv.files.get(key);
      if (!actual) throw new Error(`Immutable import input changed or missing: ${entry.path}`);
      if (mutableSet.has(key) || (actual.sha256 === entry.sha256 && actual.bytes === entry.bytes)) continue;
      const allowedMeta = importMetas.get(key);
      let identical = false;
      if (allowedMeta) {
        try {
          identical = isDeepStrictEqual(comparable(parseDocument(utf8(await read(inv, actual.path)))), comparable(parseDocument(meta(allowedMeta.job, allowedMeta.kind))));
        } catch { /* A malformed document cannot be accepted as normalization. */ }
      }
      if (!identical) throw new Error(`Immutable import input changed or missing: ${entry.path}; metadata must retain the exact resource, GUID, SourceFile, platform inheritance and complete field structure`);
      // Preserve the preparation's original fingerprint. Native formatting is
      // recorded separately and never silently reseals the input manifest.
      normalizedMetas.push({ path: actual.path, preparedSha256: entry.sha256, preparedBytes: entry.bytes, nativeSha256: actual.sha256, nativeBytes: actual.bytes, validation: 'Identical parsed metadata structure; formatting/comments only' });
    }
    const generatedMetas = [];
    for (const [key, file] of inv.files) {
      if (expectedFiles.has(key) || key === IMPORT_MANIFEST) continue;
      let match;
      for (const job of jobs) for (const kind of ['candidate', 'control']) if (key === `${job[kind].txa}.meta`.toLowerCase()) match = { job, kind };
      if (!match || !isDeepStrictEqual(comparable(parseDocument(utf8(await read(inv, file.path)))), comparable(parseDocument(meta(match.job, match.kind))))) throw new Error(`Unexpected or unsafe Workbench-generated file: ${file.path}`);
      generatedMetas.push(file);
    }
    // Re-cloning must be a no-op: old mounts or changed skeleton paths cannot be retained.
    const projectText = utf8(await read(inv, PROJECT));
    const projectEntries = parseDocument(projectText), pc = named(named(projectEntries[0], 'Configurations')[0], 'GameProjectConfigClass').find(entry => values(entry)[1] === 'PC');
    const directories = named(pc, 'FileSystem')[0]?.children?.map(entry => named(entry, 'Directory')[0]?.head[1]?.value);
    if (!directories || directories.length !== 2 || path.resolve(directories[0]) !== path.resolve(inv.root, MOUNT)) throw new Error('Import project mount differs from its isolated directory');
    const game = await directory(directories[1]);
    if (overlap(game, inv.root) || overlap(game, prep.inv.root)) throw new Error('Game mount overlaps prepared/import data');
    if (cloneImportProject(projectText, { importMount: path.join(inv.root, MOUNT), gameRoot: game, skeletonResource: `${NAMESPACE}/skeletons.anim.xml` }) !== projectText) throw new Error('Import project contains unexpected FileSystem or skeleton configuration');
    const checks = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i], preparedJob = prep.jobs[i], baseline = controls.get(job.source);
      const candidateBuffer = await read(inv, job.candidate.anm), controlBuffer = await read(inv, job.control.anm), originalBuffer = await read(prep.inv, preparedJob.anm.path);
      if (sha(candidateBuffer) === baseline.originalAnmSha256) throw new Error(`Native candidate still contains the old ANM placeholder: ${job.source}`);
      const result = validateNativeAnimation({ candidateBuffer, controlBuffer, originalBuffer, expectedOriginalSha256: baseline.originalAnmSha256, expectedControlSha256: baseline.controlAnmSha256, expectedBones: definition.expectedBones, migrationReport: preparedJob.migration, source: job.source });
      if (!result.baselineSourceAttested || result.status !== 'native-structure-and-translations-verified') throw new Error('Native control baseline is unresolved');
      checks.push({ source: job.source, target: preparedJob.anm.path, ...result });
    }
    await immutablePrepared(prep);
    sameInventory(inv, await inventory(inv.root), 'Native import work directory');
    const result = { schema: 1, status: 'native-verified', profileId: definition.profileId, importerBuild: nativeProfile.importerBuild, preparedManifestSha256: prep.manifestSha256, importManifestSha256: inv.files.get(IMPORT_MANIFEST).sha256, planId: prep.planId, checkedClips: checks.length, nativeImportRequired: false, nativeImportValidated: true, runtimeTestEligible: true, runtimeValidation: 'not-validated', normalizedMetas, generatedMetas, checks, limitations: ['Native structure and source-bound curves checked; no editor-preview or gameplay approval.', 'The importer build is the fixed attested control baseline; executable execution is not established by a timestamp.', 'The verified controls may differ from released ANMs due to native optimization.'] };
    return { prep, inv, jobs, result, game };
  }
  async function verifyNativeImport(args) {
    options(args, ['root', 'importRoot']);
    return (await checkImport(args.root, args.importRoot)).result;
  }
  async function finalizeNativeImport(args) {
    options(args, ['root', 'importRoot', 'output']);
    const { prep, inv, jobs, result, game } = await checkImport(args.root, args.importRoot);
    const output = await newOutput(args.output, [prep.inv.root, inv.root, game]);
    return transaction(output, async staging => {
      await copyInventory(prep.inv, staging);
      for (let i = 0; i < jobs.length; i++) await fs.writeFile(path.join(staging, prep.jobs[i].anm.path), await read(inv, jobs[i].candidate.anm));
      const status = { status: 'ready-for-isolated-runtime-test', nativeImportRequired: false, nativeImportValidated: true, runtimeTestEligible: true, runtimeValidation: 'not-validated' };
      const checks = new Map(result.checks.map(check => [check.source, check]));
      const assets = { ...prep.assets, ...status, jobs: prep.assets.jobs.map(job => checks.has(job.source) ? { ...job, nativeImport: checks.get(job.source) } : job) };
      const assetMigration = { ...prep.report.assetMigration, ...status, pendingAnms: [], validatedAnms: result.checks.map(check => ({ path: check.target, sha256: check.candidateSha256 })), nativeImportReportPath: VALIDATION };
      const report = { ...prep.report, createdUtc: new Date().toISOString(), assetMigration, sourceUnchanged: true, warnings: prep.report.warnings.filter(w => typeof w !== 'string' || !w.includes('ANMs still contain original release bytes')).concat('Native ANMs are verified against the bounded source/control profile. Runtime and visual validation remain separate.') };
      await fs.writeFile(path.join(staging, ASSETS), json(assets));
      await fs.writeFile(path.join(staging, REPORT), json(report));
      await put(staging, VALIDATION, json(result));
      const staged = await inventory(staging);
      const changed = new Set([ASSETS, REPORT, ...prep.jobs.map(job => job.anm.path)].map(name => name.toLowerCase()));
      for (const [key, file] of prep.inv.files) if (!changed.has(key) && staged.files.get(key)?.sha256 !== file.sha256) throw new Error(`Finalization changed an unrelated prepared file: ${file.path}`);
      for (const check of result.checks) if (staged.files.get(check.target.toLowerCase())?.sha256 !== check.candidateSha256) throw new Error(`Final ANM copy differs from verified candidate: ${check.target}`);
      const manifest = { schema: 1, algorithm: 'SHA-256', files: [...staged.files.values()].filter(file => file.path.toLowerCase() !== PREPARED_MANIFEST).sort((a, b) => a.path.localeCompare(b.path)) };
      await fs.writeFile(path.join(staging, PREPARED_MANIFEST), json(manifest));
      await verifyProject({ root: staging });
      await immutablePrepared(prep);
      sameInventory(inv, await inventory(inv.root), 'Native import work directory');
      return { ...status, profileId: definition.profileId, checkedClips: checks.size, preparedManifestSha256: prep.manifestSha256, nativeImportReportPath: VALIDATION, assetMigration };
    });
  }
  return Object.freeze({ prepareNativeImport, verifyNativeImport, finalizeNativeImport });
}
