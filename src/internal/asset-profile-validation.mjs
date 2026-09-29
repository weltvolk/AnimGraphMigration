import { createHash } from 'node:crypto';
import { splitResourceRef } from '../resources.mjs';

export class AssetProfileError extends Error {
  constructor(message, profileId = '<asset profile>') {
    super(`${profileId}: asset profile rejected: ${message}`);
    this.name = 'AssetProfileError';
    this.profileId = profileId;
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/u;
const MAX_INVENTORY_FILES = 200000;

/**
 * Internal engine shared by the fixed registry and synthetic tests.
 * Do not expose profile-definition injection through GUI, CLI or public API.
 * Inventory entries must be freshly hashed by the caller; this function has no
 * file access and cannot establish that caller-supplied hashes match disk bytes.
 */
export function validateProfileDefinition(definition, { inventory, activeAssignments } = {}) {
  const profileId = typeof definition?.profileId === 'string' ? definition.profileId : '<asset profile>';
  const fail = message => { throw new AssetProfileError(message, profileId); };
  function safePath(value) {
    if (typeof value !== 'string' || !value) fail('missing resource path');
    const normalized = value.replaceAll('\\', '/');
    const pieces = normalized.split('/');
    if (pieces.some(piece => !piece || piece === '.' || piece === '..' || /[<>:"|?*\x00-\x1f\x7f]/u.test(piece) || /[. ]$/u.test(piece) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(piece))) fail(`unsafe resource path ${JSON.stringify(value)}`);
    return normalized;
  }
  function refPath(value) {
    try { return safePath(splitResourceRef(value).path); }
    catch (error) { if (error instanceof AssetProfileError) throw error; fail(`invalid resource reference: ${error.message}`); }
  }
  function validFingerprint(file, extension) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) fail('invalid profile fingerprint');
    const resource = safePath(file.path);
    if (!resource.toLowerCase().endsWith(extension) || !digestPattern.test(file.sha256 ?? '')) fail(`invalid profile fingerprint for ${resource}`);
    return resource;
  }

  if (!definition || definition.schema !== 1 || !Number.isInteger(definition.profileVersion) || definition.profileVersion < 1 || !profileId || !Array.isArray(definition.assignments) || !definition.assignments.length || definition.assignments.length > 10000) fail('invalid profile definition');
  const bones = definition.expectedBones;
  if (!Array.isArray(bones) || bones.length !== 64 || new Set(bones).size !== 64 || bones.some(name => typeof name !== 'string' || !name || /[\x00-\x1f\x7f]/u.test(name))) fail('profile requires 64 unique canonical bone names');
  if (definition.rootBone === definition.pelvisBone || !bones.includes(definition.rootBone) || !bones.includes(definition.pelvisBone)) fail('profile has invalid Root/Pelvis identifiers');

  const expectedSources = new Map(), expectedPaths = new Set();
  for (const job of definition.assignments) {
    if (!job || typeof job.source !== 'string' || !/^[^.\x00-\x1f]+\.[^.\x00-\x1f]+\.[^.\x00-\x1f]+$/u.test(job.source) || expectedSources.has(job.source)) fail('profile has an invalid or duplicate qualified slot');
    if (!['transform-root-motion', 'copy-unchanged'].includes(job.action)) fail(`unsupported profile action for ${job.source}`);
    const anmPath = validFingerprint(job.anm, '.anm'), txaPath = validFingerprint(job.txa, '.txa');
    if (anmPath.slice(0, -4).toLowerCase() !== txaPath.slice(0, -4).toLowerCase()) fail(`profile ANM/TXA stems differ for ${job.source}`);
    for (const resource of [anmPath, txaPath]) {
      if (expectedPaths.has(resource.toLowerCase())) fail(`profile resource used more than once: ${resource}`);
      expectedPaths.add(resource.toLowerCase());
    }
    expectedSources.set(job.source, job);
  }

  if (!(inventory instanceof Map) && !Array.isArray(inventory)) fail('inventory must be a Map or array of hashed file entries');
  const inventorySize = inventory instanceof Map ? inventory.size : inventory.length;
  if (inventorySize > MAX_INVENTORY_FILES) fail('inventory exceeds the supported size');
  const files = new Map();
  for (const entry of inventory instanceof Map ? inventory.values() : inventory) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid inventory entry');
    const resource = safePath(entry.path), key = resource.toLowerCase();
    if (files.has(key)) fail(`case-insensitive inventory collision: ${resource}`);
    if (key === '.animgraph-migration' || key.startsWith('.animgraph-migration/')) fail('migration report found; choose the original source');
    if (typeof entry.sha256 !== 'string' || !digestPattern.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`invalid inventory hash or size: ${resource}`);
    files.set(key, { path: resource, bytes: entry.bytes, sha256: entry.sha256 });
  }

  if (!Array.isArray(activeAssignments) || activeAssignments.length !== expectedSources.size) fail(`expected the complete ${expectedSources.size} active assignments`);
  const actualSources = new Map();
  for (const assignment of activeAssignments) {
    if (!assignment || typeof assignment.source !== 'string' || !expectedSources.has(assignment.source)) fail(`unknown active animation slot: ${assignment?.source ?? '<missing>'}`);
    if (actualSources.has(assignment.source)) fail(`duplicate active animation slot: ${assignment.source}`);
    const resource = refPath(assignment.resource);
    const expected = expectedSources.get(assignment.source);
    if (resource.toLowerCase() !== expected.anm.path.toLowerCase()) fail(`unexpected animation resource for ${assignment.source}: ${resource}`);
    actualSources.set(assignment.source, resource);
  }

  const jobs = [];
  for (const expected of definition.assignments) {
    if (!actualSources.has(expected.source)) fail(`missing active animation slot: ${expected.source}`);
    const checked = {};
    for (const kind of ['anm', 'txa']) {
      const fingerprint = expected[kind], actual = files.get(fingerprint.path.toLowerCase());
      if (!actual) fail(`missing original ${kind.toUpperCase()}: ${fingerprint.path}`);
      if (actual.sha256 !== fingerprint.sha256) fail(`original fingerprint mismatch: ${actual.path}; unknown or previously transformed assets are not accepted`);
      checked[kind] = { ...actual };
    }
    jobs.push({ source: expected.source, resource: checked.anm.path, action: expected.action, ...checked });
  }
  const canonical = {
    profileId, profileVersion: definition.profileVersion,
    rootBone: definition.rootBone, pelvisBone: definition.pelvisBone, expectedBones: bones,
    assignments: definition.assignments.map(job => ({ source: job.source, action: job.action, anm: { path: job.anm.path.toLowerCase(), sha256: job.anm.sha256 }, txa: { path: job.txa.path.toLowerCase(), sha256: job.txa.sha256 } })).sort((a, b) => a.source.localeCompare(b.source, 'en')),
  };
  const requiredClipCount = jobs.filter(job => job.action === 'transform-root-motion').length;
  return {
    schema: 1, profileId, profileVersion: definition.profileVersion,
    planId: sha256(JSON.stringify(canonical)), status: 'ready-for-txa-preparation',
    activeAssignmentCount: jobs.length, requiredClipCount, unchangedClipCount: jobs.length - requiredClipCount,
    rootBone: definition.rootBone, pelvisBone: definition.pelvisBone, expectedBones: [...bones],
    sourceProvenanceVerified: true, nativeImportRequired: requiredClipCount > 0,
    nativeImportValidated: false, runtimeTestEligible: false, runtimeValidated: false,
    jobs,
  };
}
