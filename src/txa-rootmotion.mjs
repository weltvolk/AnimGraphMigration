/**
 * Bounded Blackbird TXA transformation. No file access or native ANM generation.
 * Structural matching does not establish source provenance: the caller MUST
 * verify the original digest through a trusted profile before applying it.
 * The operation is not idempotent and cannot identify a stripped prior output.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, values, children } from './syntax.mjs';

export const ROOT_MOTION_PROFILE_ID = 'blackbird-2.08-motion-v1';
export const ROOT_MOTION_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxFrames: 10000, maxFps: 240, bones: 64 });

export class TxaRootMotionError extends Error {
  constructor(message, source) {
    super(`${source}: unsupported TXA profile: ${message}`);
    this.name = 'TxaRootMotionError';
    this.source = source;
  }
}

const ROOT = 'entityposition';
const PELVIS = 'blackbird_Pelvis_bone';
const EXPECTED_Q = [-0.7071068, 0, 0, 0.7071068];
const EXPECTED_SCALE = [0.2002, 0.2002, 0.2002];
const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const T_LINE = new RegExp(`^([ \\t]*#t[ \\t]+)(${NUM})([ \\t]+)(${NUM})([ \\t]+)(${NUM})([ \\t]*(?://[^\\r\\n]*)?)(\\r?\\n)?$`);
const round = n => Number(n.toFixed(7));
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export function migrateRootMotionTxa(text, { source = '<TXA>' } = {}) {
  if (typeof source !== 'string' || !source) throw new TypeError('source must be a nonempty diagnostic label');
  const fail = message => { throw new TxaRootMotionError(message, source); };
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > ROOT_MOTION_LIMITS.maxBytes) fail('expected a text document no larger than 8 MiB');
  if (text.includes('\0')) fail('NUL characters are not supported');
  const original = parseDocument(text, { source });
  if (original.length !== 1 || values(original[0])[0] !== '$animation' || values(original[0]).length !== 2 || original[0].children === null) fail('expected one named animation block');
  const animation = original[0];
  function only(entry, name) {
    const found = children(entry, name);
    if (found.length !== 1) fail(`expected exactly one ${name}`);
    return found[0];
  }
  function numbers(entry, size, context) {
    if (entry.children !== null) fail(`expected scalar ${context}`);
    const raw = values(entry).slice(1);
    const result = raw.map(Number);
    if (raw.length !== size || raw.some(v => !new RegExp(`^${NUM}$`).test(v)) || result.some(v => !Number.isFinite(v))) fail(`non-finite or invalid ${context}`);
    return result;
  }
  const version = numbers(only(animation, '#version'), 1, 'version')[0];
  const fps = numbers(only(animation, '#fps'), 1, 'fps')[0];
  const numFrames = numbers(only(animation, '#numFrames'), 1, 'numFrames')[0];
  if (version !== 1 || !Number.isInteger(fps) || fps <= 0 || fps > ROOT_MOTION_LIMITS.maxFps || !Number.isInteger(numFrames) || numFrames < 2 || numFrames > ROOT_MOTION_LIMITS.maxFrames) fail('version, frame rate or frame count outside the bounded profile');

  // Accept only the structural families used by this profile. Untouched data
  // is preserved byte-for-byte, but unknown semantic fields are not accepted.
  function schema(entry, allowed, repeated = []) {
    const seen = new Set();
    for (const item of entry.children ?? []) {
      const name = values(item)[0];
      if (!allowed.includes(name)) fail(`unsupported field ${name}`);
      if (seen.has(name) && !repeated.includes(name)) fail(`duplicate field ${name}`);
      seen.add(name);
    }
  }
  schema(animation, ['#version', '#fps', '#numFrames', '$node'], ['$node']);

  const nodes = new Map();
  function visit(entries, parent = null) {
    for (const entry of entries ?? []) {
      const head = values(entry);
      if (head[0] === '$node') {
        if (head.length !== 2 || !head[1] || /[\x00-\x1f\x7f]/u.test(head[1]) || nodes.has(head[1]) || entry.children === null) fail('invalid or duplicate bone name');
        if (nodes.size >= ROOT_MOTION_LIMITS.bones) fail('expected 64 bones; extra bone found');
        schema(entry, ['$keys', '$node'], ['$node']);
        const keys = only(entry, '$keys');
        if (values(keys).join(' ') !== '$keys t q s' || keys.children === null) fail('expected t q s key channels');
        schema(keys, ['$frame'], ['$frame']);
        for (const frame of keys.children) {
          const spec = values(frame).slice(1);
          if (spec.length < 1 || spec.length > 2 || spec.some(v => !/^\d+$/u.test(v) || Number(v) >= numFrames) || (spec.length === 2 && Number(spec[1]) < Number(spec[0])) || frame.children === null) fail('invalid frame specification');
          schema(frame, ['#t', '#q', '#s']);
        }
        nodes.set(head[1], { entry, parent });
        visit(entry.children, head[1]);
      } else if (entry.children) {
        visit(entry.children, parent);
      } else if (['#t', '#q', '#s'].includes(head[0])) {
        numbers(entry, head[0] === '#q' ? 4 : 3, head[0]);
      }
    }
  }
  visit(animation.children);
  if (nodes.size !== ROOT_MOTION_LIMITS.bones) fail(`expected 64 bones, found ${nodes.size}`);
  const root = nodes.get(ROOT), pelvis = nodes.get(PELVIS);
  const rootChildren = [...nodes].filter(([, node]) => node.parent === ROOT).map(([name]) => name);
  if (!root || !pelvis || root.parent !== 'Armature' || nodes.get('Armature')?.parent !== 'Scene_Root' || nodes.get('Scene_Root')?.parent !== null || rootChildren.length !== 1 || rootChildren[0] !== PELVIS) fail('expected Scene_Root/Armature/entityposition with Pelvis as the sole direct child');

  function framesFor(node) {
    const keys = only(node.entry, '$keys');
    if (values(keys).join(' ') !== '$keys t q s') fail('expected t q s key channels');
    return keys.children ?? [];
  }
  const rootFrames = framesFor(root), pelvisFrames = framesFor(pelvis);
  function frameLayout(frames) {
    let next = 0;
    const layout = frames.map(frame => {
      const head = values(frame), spec = head.slice(1).map(Number);
      if (head[0] !== '$frame' || spec.length < 1 || spec.length > 2 || spec.some(v => !Number.isInteger(v) || v < 0)) fail('invalid frame specification');
      const start = spec[0], end = spec[1] ?? start;
      if (start !== next || end < start || end >= numFrames) fail('frame coverage has a gap, overlap or out-of-range index');
      next = end + 1;
      for (const entry of frame.children ?? []) {
        if (!['#t', '#q', '#s'].includes(values(entry)[0]) || entry.children) fail('unexpected channel within Root/Pelvis frame');
      }
      for (const channel of ['#t', '#q', '#s']) {
        const count = children(frame, channel).length;
        if (count > 1 || (channel === '#t' && count !== 1)) fail(`missing or duplicate ${channel} in Root/Pelvis frame`);
      }
      return { start, end, spec };
    });
    if (next !== numFrames) fail('incomplete frame coverage');
    return layout;
  }
  const layout = frameLayout(rootFrames), pelvisLayout = frameLayout(pelvisFrames);
  if (JSON.stringify(layout) !== JSON.stringify(pelvisLayout)) fail('Root/Pelvis frame specifications differ');
  function constantChannel(frames, channel, expected, label) {
    if (children(frames[0], channel).length !== 1) fail(`missing initial ${label}`);
    for (const frame of frames) for (const item of children(frame, channel)) {
      const actual = numbers(item, expected.length, label);
      if (actual.some((v, i) => Math.abs(v - expected[i]) > 1e-7)) fail(`unexpected or varying ${label}`);
    }
  }
  constantChannel(rootFrames, '#q', EXPECTED_Q, 'Root quaternion');
  constantChannel(rootFrames, '#s', EXPECTED_SCALE, 'Root scale');
  const armatureFrames = framesFor(nodes.get('Armature'));
  if (!armatureFrames.length) fail('missing Armature keys');
  constantChannel(armatureFrames, '#s', EXPECTED_SCALE, 'Armature scale');

  const lines = text.split(/(?<=\n)/), changes = [], keyChecks = [];
  const first = numbers(only(rootFrames[0], '#t'), 3, 'initial Root translation');
  function patch(entry, after, bone, frame) {
    const before = numbers(entry, 3, `${bone} translation`);
    const lineIndex = entry.line - 1, originalLine = lines[lineIndex];
    const match = T_LINE.exec(originalLine ?? '');
    if (!match) fail('translation must occupy its own numeric line; inline blocks/comments are unsupported');
    const preserve = frame.start === 0 || after.every((v, i) => v === before[i]);
    const newLine = preserve ? originalLine : `${match[1]}${after[0].toFixed(7)}${match[3]}${after[1].toFixed(7)}${match[5]}${after[2].toFixed(7)}${match[7]}${match[8] ?? ''}`;
    if (newLine !== originalLine) {
      if (changes.some(change => change.line === entry.line)) fail('multiple translations share a source line');
      changes.push({ bone, frames: frame.spec, line: entry.line, before, after, originalLine, newLine });
      lines[lineIndex] = newLine;
    }
    return preserve ? before : after;
  }
  let maxPoseCancellationError = 0;
  for (let i = 0; i < layout.length; i++) {
    const oldRoot = numbers(only(rootFrames[i], '#t'), 3, 'Root translation');
    const oldPelvis = numbers(only(pelvisFrames[i], '#t'), 3, 'Pelvis translation');
    const delta = oldRoot.map((v, axis) => round(v - first[axis]));
    const newRoot = [round(first[0] + delta[0]), round(first[1] - delta[2]), round(first[2] + delta[1])];
    const counter = [0, round(delta[1] - delta[2]), round(delta[1] + delta[2])];
    const newPelvis = oldPelvis.map((v, axis) => round(v + counter[axis]));
    if ([...newRoot, ...newPelvis].some(v => !Number.isFinite(v) || Math.abs(v) >= 1e15)) fail('translation exceeds bounded decimal output');
    const actualRoot = patch(only(rootFrames[i], '#t'), newRoot, ROOT, layout[i]);
    const actualPelvis = patch(only(pelvisFrames[i], '#t'), newPelvis, PELVIS, layout[i]);
    // R = Rx(-90 degrees). Unit effective displacement is the measured
    // Blackbird export profile, not a claim about arbitrary literal TXA scales.
    const pose = (r, p) => [r[0] + p[0], r[1] + p[2], r[2] - p[1]];
    const beforePose = pose(oldRoot, oldPelvis), afterPose = pose(actualRoot, actualPelvis);
    const error = Math.max(...beforePose.map((v, axis) => Math.abs(v - afterPose[axis])));
    maxPoseCancellationError = Math.max(maxPoseCancellationError, error);
    if (error > 0.00000021) fail('rounded Root/Pelvis pose cancellation exceeds tolerance');
    keyChecks.push({ frames: layout[i].spec, originalRoot: oldRoot, originalPelvis: oldPelvis, rootDelta: delta, counter, newRoot: actualRoot, newPelvis: actualPelvis, poseCancellationError: error });
  }
  const migrated = lines.join('');
  const reversed = [...lines];
  for (const change of changes) reversed[change.line - 1] = change.originalLine;
  if (reversed.join('') !== text) fail('exact reversal detected an unintended byte change');
  const reparsed = parseDocument(migrated, { source: `${source} [migrated copy]` });
  const changedLines = new Set(changes.map(change => change.line));
  function withoutTargetTranslations(entries) {
    return entries.filter(entry => !(changedLines.has(entry.line) && values(entry)[0] === '#t')).map(entry => ({ head: values(entry), children: entry.children === null ? null : withoutTargetTranslations(entry.children) }));
  }
  if (JSON.stringify(withoutTargetTranslations(original)) !== JSON.stringify(withoutTargetTranslations(reparsed))) fail('reparse detected a change outside intended translation values');
  if (changes.some(change => change.frames[0] === 0)) fail('first Root/Pelvis frame changed');
  return {
    text: migrated,
    report: {
      source, profileId: ROOT_MOTION_PROFILE_ID,
      profile: 'Blackbird64 constant RootQ sole Pelvis; unit effective translation scale',
      rootBone: ROOT, pelvisBone: PELVIS, boneNames: [...nodes.keys()],
      requiresVerifiedOriginal: true, sourceProvenanceVerified: false,
      nativeImportRequired: true, runtimeValidated: false,
      sourceSha256: hash(text), outputSha256: hash(migrated), boneCount: nodes.size, fps, numFrames,
      frameBlocks: layout.map(({ start, end, spec }) => ({ start, end, spec })),
      changedLines: changes.length, frameZeroUnchanged: true, exactReversalVerified: true,
      nonTranslationStructureAndTokensUnchanged: true, maxPoseCancellationError, changes, keys: keyChecks,
      rule: 'Preserve initial Root-T; rotate increments (dx,dy,dz) to (dx,-dz,dy); add (0,dy-dz,dy+dz) to Pelvis; round changed output to 7 decimal places.',
      limitations: ['Bounded structural profile only; original digest verification, native Workbench rebuild and runtime/transition tests remain required.', 'Not idempotent: apply only once to a verified immutable legacy source; a previously transformed source is not reliably identifiable by this structural profile.', 'No arbitrary Root rotations, scales, multiple direct children, incomplete or differently keyed Root/Pelvis tracks, unknown fields, or malformed source documents.', 'Pose cancellation is checked in the empirically supported unit effective displacement profile, not a general TXA scale interpreter.'],
    },
  };
}

/**
 * Reconstruct the exact original TXA for a native control import. This returns
 * a string and performs no writes. Both hashes, every reverse-patch line and
 * all transformation facts are checked by repeating the forward conversion.
 * The caller still needs the fixed profile's trusted original fingerprint.
 */
export function restoreOriginalTxa(preparedText, migrationReport) {
  const report = migrationReport;
  const source = typeof report?.source === 'string' && report.source ? report.source : '<TXA restoration>';
  const fail = message => { throw new TxaRootMotionError(`cannot restore original: ${message}`, source); };
  if (typeof preparedText !== 'string' || Buffer.byteLength(preparedText, 'utf8') > ROOT_MOTION_LIMITS.maxBytes) fail('prepared text exceeds the supported bounds');
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.profileId !== ROOT_MOTION_PROFILE_ID || typeof report.source !== 'string' || !report.source) fail('missing or unsupported migration report');
  for (const field of ['sourceSha256', 'outputSha256']) if (typeof report[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(report[field])) fail(`invalid ${field}`);
  if (hash(preparedText) !== report.outputSha256) fail('prepared output SHA-256 mismatch');
  if (!Array.isArray(report.changes) || report.changes.length > ROOT_MOTION_LIMITS.maxFrames * 2) fail('invalid reverse-patch list');

  const lines = preparedText.split(/(?<=\n)/), used = new Set();
  let restoredBytes = Buffer.byteLength(preparedText, 'utf8');
  for (const change of report.changes) {
    if (!change || typeof change !== 'object' || !Number.isSafeInteger(change.line) || change.line < 1 || change.line > lines.length || used.has(change.line)) fail('invalid or duplicate reverse-patch line');
    if (![ROOT, PELVIS].includes(change.bone)) fail('reverse-patch bone is outside the profile');
    for (const field of ['originalLine', 'newLine']) {
      if (typeof change[field] !== 'string' || T_LINE.exec(change[field])?.[0] !== change[field]) fail(`invalid ${field}; expected one complete translation line`);
    }
    if (lines[change.line - 1] !== change.newLine) fail(`prepared line ${change.line} differs from the report`);
    restoredBytes += Buffer.byteLength(change.originalLine, 'utf8') - Buffer.byteLength(change.newLine, 'utf8');
    if (restoredBytes > ROOT_MOTION_LIMITS.maxBytes) fail('restored text exceeds the supported bounds');
    used.add(change.line);
    lines[change.line - 1] = change.originalLine;
  }
  const original = lines.join('');
  if (hash(original) !== report.sourceSha256) fail('original source SHA-256 mismatch');
  const repeated = migrateRootMotionTxa(original, { source: report.source });
  if (repeated.text !== preparedText) fail('forward transformation does not reproduce the prepared text');
  const facts = ['profileId', 'rootBone', 'pelvisBone', 'boneNames', 'sourceSha256', 'outputSha256', 'boneCount', 'fps', 'numFrames', 'frameBlocks', 'changedLines', 'frameZeroUnchanged', 'exactReversalVerified', 'nonTranslationStructureAndTokensUnchanged', 'maxPoseCancellationError', 'changes', 'keys', 'rule'];
  for (const field of facts) if (!isDeepStrictEqual(report[field], repeated.report[field])) fail(`migration report field ${field} differs from the repeated transformation`);
  return original;
}
