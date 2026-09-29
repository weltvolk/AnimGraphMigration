import crypto from 'node:crypto';
import { ANM_SET6_LIMITS, parseAnmSet6 } from './anm-set6.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const maximumError = (actual, expected) => Math.max(...actual.map((value, axis) => Math.abs(value - expected[axis])));
const remapRoot = (value, base) => [value[0], base[1] - (value[2] - base[2]), base[2] + (value[1] - base[1])];

function sourceTranslationQuantization(keys, field) {
  let minimum = Infinity, maximum = -Infinity;
  for (const key of keys) for (const value of key[field]) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  // The bounded importer profile first reads float32 source coordinates, then
  // stores their float32 minimum and float32(maximum - minimum). Derive this
  // independently of candidate bytes: candidate ranges must never enlarge the
  // error budget used to validate those same untrusted bytes.
  const min = Math.fround(minimum), max = Math.fround(maximum);
  return { sourceMinimum: minimum, sourceMaximum: maximum, min, max, range: Math.fround(max - min) };
}

function interpolate(keys, frame) {
  // The bounded reader guarantees ordered, nonempty keys. Native constant
  // tracks need not contain a last-frame key, so endpoint values are held.
  let left = keys[0];
  if (frame <= left.frame) return left.value;
  for (let index = 1; index < keys.length; index++) {
    const right = keys[index];
    if (frame === right.frame) return right.value;
    if (frame < right.frame) {
      const fraction = (frame - left.frame) / (right.frame - left.frame);
      return left.value.map((value, axis) => value + (right.value[axis] - value) * fraction);
    }
    left = right;
  }
  return left.value;
}

/**
 * Check a pair of native importer outputs against a verified original ANM and
 * the bounded TXA migration report. This function performs no I/O or mutation.
 * expectedBones and expectedOriginalSha256 must come from the caller's trusted
 * source inventory, not from the candidate being checked.
 * expectedControlSha256, when supplied, must come from an attested per-clip
 * native import manifest associating the unmodified TXA with its native output.
 * Computing it from an untrusted control Buffer does not establish provenance.
 * Without that attestation this returns an unresolved baseline comparison, not
 * a verified native migration, even if all numerical comparisons succeed.
 */
export function validateNativeAnimation({
  candidateBuffer, controlBuffer, originalBuffer, expectedOriginalSha256, expectedControlSha256,
  expectedBones, migrationReport, source = '<native animation comparison>',
} = {}) {
  const fail = message => { throw new Error(`${source}: native animation check failed: ${message}`); };
  for (const [name, buffer] of Object.entries({ candidateBuffer, controlBuffer, originalBuffer })) {
    if (!Buffer.isBuffer(buffer)) fail(`${name} must be a Buffer`);
    if (buffer.length > ANM_SET6_LIMITS.maxBytes) fail(`${name} exceeds the supported size limit`);
  }
  if (typeof expectedOriginalSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedOriginalSha256)) fail('a trusted original SHA-256 is required');
  const originalSha256 = sha256(originalBuffer);
  if (originalSha256 !== expectedOriginalSha256.toLowerCase()) fail('original ANM SHA-256 does not match the trusted inventory');
  const controlSha256 = sha256(controlBuffer);
  const baselineSourceAttested = expectedControlSha256 !== undefined;
  if (baselineSourceAttested) {
    if (typeof expectedControlSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedControlSha256)) fail('expectedControlSha256 must be a trusted per-clip native control SHA-256');
    if (controlSha256 !== expectedControlSha256.toLowerCase()) fail('native control SHA-256 does not match the attested source baseline');
  }
  if (!Array.isArray(expectedBones) || expectedBones.length !== 64 || new Set(expectedBones).size !== 64 || expectedBones.some(name => typeof name !== 'string' || !name.length)) fail('expectedBones must contain exactly 64 unique canonical bone names');

  const report = migrationReport;
  if (!report || report.boneCount !== 64 || !Number.isInteger(report.numFrames) || report.numFrames < 2 || report.numFrames > 10000) fail('invalid migration report bone/frame count');
  if (!Number.isInteger(report.fps) || report.fps < 1 || report.fps > ANM_SET6_LIMITS.maxFps) fail('migration report FPS must match the supported integer native metadata');
  const { rootBone, pelvisBone } = report;
  if (typeof rootBone !== 'string' || typeof pelvisBone !== 'string' || rootBone === pelvisBone || !expectedBones.includes(rootBone) || !expectedBones.includes(pelvisBone)) fail('migration report must identify distinct canonical Root and Pelvis bones');
  if (!Array.isArray(report.keys) || report.keys.length === 0 || report.keys.length > report.numFrames) fail('missing or invalid source frame blocks');

  const frames = [];
  let nextFrame = 0;
  const base = report.keys[0]?.originalRoot;
  if (!vector(base)) fail('invalid first source Root translation');
  for (const key of report.keys) {
    if (!key || typeof key !== 'object') fail('invalid source frame block');
    if (!Array.isArray(key.frames) || key.frames.length < 1 || key.frames.length > 2 || key.frames.some(frame => !Number.isInteger(frame))) fail('invalid source frame specification');
    const [start, end = start] = key.frames;
    if (start !== nextFrame || end < start || end >= report.numFrames) fail('source frame coverage has a gap, overlap or out-of-range index');
    for (const field of ['originalRoot', 'originalPelvis', 'newRoot', 'newPelvis']) if (!vector(key[field])) fail(`invalid ${field} source vector`);
    const delta = key.originalRoot.map((value, axis) => value - base[axis]);
    const expectedPelvis = [key.originalPelvis[0], key.originalPelvis[1] + delta[1] - delta[2], key.originalPelvis[2] + delta[1] + delta[2]];
    // The TXA profile rounds intermediate deltas and final values to 7 decimals.
    if (maximumError(key.newRoot, remapRoot(key.originalRoot, base)) > 0.00000021 || maximumError(key.newPelvis, expectedPelvis) > 0.00000021) fail('migration report does not implement the supported Root/Pelvis transformation');
    if (start === 0 && (maximumError(key.originalRoot, key.newRoot) !== 0 || maximumError(key.originalPelvis, key.newPelvis) !== 0)) fail('migration report changes the initial Root/Pelvis frame');
    for (let frame = start; frame <= end; frame++) frames.push({ ...key, frame });
    nextFrame = end + 1;
  }
  if (nextFrame !== report.numFrames) fail('source frame coverage is incomplete');

  const original = parseAnmSet6(originalBuffer, { source: `${source} original` });
  const control = parseAnmSet6(controlBuffer, { source: `${source} control` });
  const candidate = parseAnmSet6(candidateBuffer, { source: `${source} candidate` });
  for (const [kind, parsed] of Object.entries({ original, control, candidate })) {
    if (parsed.records.length !== 64 || parsed.records.some((record, index) => record.name !== expectedBones[index])) fail(`${kind} bone names/order do not match the canonical inventory`);
    if (parsed.records.some(record => record.frames !== report.numFrames)) fail(`${kind} frame metadata differs from the migration report`);
    if (parsed.chunks.length !== original.chunks.length || parsed.chunks.some((chunk, index) => chunk.id !== original.chunks[index].id)) fail(`${kind} container chunk layout differs from the original`);
    for (let index = 0; index < parsed.chunks.length; index++) {
      const chunk = parsed.chunks[index];
      if (!['HEAD', 'DATA'].includes(chunk.id) && !chunk.data.equals(original.chunks[index].data)) fail(`${kind} immutable container metadata differs from the original`);
    }
    if (parsed.fps !== report.fps) fail(`${kind} FPS metadata differs from the TXA migration report`);
  }

  let unchangedBones = 0;
  const checks = [];
  const candidateTranslationQuantization = [];
  let rootCurveEquivalence;
  for (let index = 0; index < candidate.records.length; index++) {
    const record = candidate.records[index], baseline = control.records[index];
    if (record.name !== rootBone && record.name !== pelvisBone) {
      if (!record.header.equals(baseline.header) || !record.data.equals(baseline.data)) fail(`unrelated bone HEAD/DATA changed: ${record.name}`);
      unchangedBones++;
      continue;
    }

    // Translation quantization (bytes 0..7) and translation-key count
    // (26..27) may change. All other record metadata must be byte-identical.
    if (!record.header.subarray(8, 26).equals(baseline.header.subarray(8, 26)) || !record.header.subarray(28).equals(baseline.header.subarray(28))) fail(`Root/Pelvis immutable frame, rotation or scale metadata changed: ${record.name}`);
    for (const channel of ['q', 's']) {
      if (!record[channel].equals(baseline[channel]) || !record.quantization[channel].header.equals(baseline.quantization[channel].header)) fail(`Root/Pelvis rotation/scale bytes or quantization changed: ${record.name}`);
    }
    if (record.counts[1] !== baseline.counts[1] || record.counts[2] !== baseline.counts[2]) fail(`Root/Pelvis rotation/scale key counts changed: ${record.name}`);
    if (!record.translation.length || !baseline.translation.length) fail(`missing translation channel: ${record.name}`);

    const sourceQuantization = sourceTranslationQuantization(report.keys, record.name === rootBone ? 'newRoot' : 'newPelvis');
    if (!Number.isFinite(sourceQuantization.min) || !Number.isFinite(sourceQuantization.range) || record.minT !== sourceQuantization.min || record.rangeT !== sourceQuantization.range) fail(`candidate source-bound translation quantization differs from TXA float32 extrema: ${record.name}`);
    candidateTranslationQuantization.push({ bone: record.name, ...sourceQuantization, exactMatch: true });

    if (record.name === rootBone) {
      if (record.translation.length !== baseline.translation.length || record.translation.some((key, keyIndex) => key.frame !== baseline.translation[keyIndex].frame)) fail('native Root key times differ between candidate and control');
      const bound = 2 * (sourceQuantization.range + Math.abs(baseline.rangeT)) / 65535 + 0.000001;
      let maxRemappedControlError = 0;
      for (const { frame } of frames) {
        const actual = interpolate(record.translation, frame);
        const expected = remapRoot(interpolate(baseline.translation, frame), base);
        const error = maximumError(actual, expected);
        if (error > bound) fail(`native Root differs from remapped control at source frame ${frame} (${error} > ${bound})`);
        maxRemappedControlError = Math.max(maxRemappedControlError, error);
      }
      rootCurveEquivalence = { checkedSourceFrames: frames.length, keyTimesIdentical: true, maxRemappedControlError, combinedQuantizationBound: bound };
    }

    for (const [kind, track, field] of [
      ['candidate', record, record.name === rootBone ? 'newRoot' : 'newPelvis'],
      ['control', baseline, record.name === rootBone ? 'originalRoot' : 'originalPelvis'],
    ]) {
      const bound = 2 * (kind === 'candidate' ? sourceQuantization.range : Math.abs(track.rangeT)) / 65535 + 0.000001;
      let maxSourceFrameError = 0;
      for (const key of frames) {
        const error = maximumError(interpolate(track.translation, key.frame), key[field]);
        if (kind === 'candidate' && record.name === pelvisBone && error > bound) fail(`candidate Pelvis differs from TXA source at frame ${key.frame} (${error} > ${bound})`);
        maxSourceFrameError = Math.max(maxSourceFrameError, error);
      }
      checks.push({ kind, bone: record.name, checkedSourceFrames: frames.length, nativeTranslationKeys: track.translation.length, maxSourceFrameError, pureQuantizationBound: bound, withinPureQuantization: maxSourceFrameError <= bound, validation: kind === 'control' ? 'Baseline source simplification measured only' : record.name === rootBone ? 'Equivalence to remapped native control' : 'Equivalence to migrated source within quantization' });
    }
  }

  return {
    schemaVersion: 1,
    status: baselineSourceAttested ? 'native-structure-and-translations-verified' : 'native-comparison-baseline-unattested',
    baselineSourceAttested,
    unresolved: baselineSourceAttested ? [] : ['The native control/source association needs a trusted per-clip control SHA-256 from an attested import manifest.'],
    gameplayValidated: false,
    originalSha256, candidateSha256: sha256(candidateBuffer), controlSha256,
    controlEqualsOriginal: controlBuffer.equals(originalBuffer),
    boneCount: candidate.records.length, numFrames: report.numFrames,
    frameRateMetadata: { sourceFps: report.fps, encodedFps: candidate.fps, matchesSource: true },
    checkedSourceFrames: frames.length, unchangedBones,
    canonicalBoneNamesAndOrderVerified: true,
    immutableContainerMetadataByteIdentical: true,
    rootPelvisRotationScaleBytesQuantizationCountsAndFrameMetadataIdentical: true,
    candidateTranslationQuantizationSourceBound: true,
    candidateTranslationQuantization,
    rootCurveEquivalence, checks,
    limitations: [
      'This is a bounded structural and numerical check, not a gameplay or preview approval.',
      'The caller must attest the original digest, canonical inventory, source TXA provenance and association of the native control/candidate imports.',
      'The bounded FPS metadata equals the source integer frame rate; this does not prove runtime playback timing or interpolation semantics.',
      'Control source simplification is measured; Root equivalence preserves that native control curve instead of asserting exact recovery of all source keys.',
    ],
  };
}
