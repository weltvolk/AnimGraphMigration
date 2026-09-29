import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseAnmSet6 } from '../src/anm-set6.mjs';
import { validateNativeAnimation } from '../src/native-animation-check.mjs';

// Entirely synthetic in-memory containers; no game/mod fixtures or user paths.
const bones = ['Root', 'Pelvis', ...Array.from({ length: 62 }, (_, index) => `Joint_${String(index).padStart(2, '0')}`)];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const xyz = (frame, value) => ({ frame, value });
const track = values => values.map((value, frame) => xyz(frame, value));
const originalRoot = track([[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]]);
const migratedRoot = track([[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3]]);
const originalPelvis = [xyz(0, [0, 0, 0])];
const migratedPelvis = track([[0, 0, 0], [0, 1, 1], [0, 2, 2], [0, 3, 3]]);

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'latin1');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function encode(keys, components, min, range) {
  const data = Buffer.alloc(keys.length * (components + 1) * 2);
  keys.forEach(({ frame, value }, index) => {
    data.writeUInt16LE(frame, index * 2);
    value.forEach((number, axis) => {
      const encoded = range === 0 ? 0 : Math.round((number - min) * 65535 / range);
      assert.ok(encoded >= 0 && encoded <= 65535, 'synthetic encoder range');
      data.writeUInt16LE(encoded, keys.length * 2 + (index * components + axis) * 2);
    });
  });
  return data;
}

function makeAnm({ names = bones, frames = 4, fps = 30, root = originalRoot, pelvis = originalPelvis, translationRange = 3, qRange = 2, sRange = 1, rootRotation = [xyz(0, [0, 0, 0, 1])], rootScale = [xyz(0, [1, 1, 1])] } = {}) {
  const headers = [], data = [];
  for (const name of names) {
    const translation = name === 'Root' ? root : name === 'Pelvis' ? pelvis : [xyz(0, [0, 0, 0])];
    const rotation = name === 'Root' ? rootRotation : [xyz(0, [0, 0, 0, 1])];
    const scale = name === 'Root' ? rootScale : [xyz(0, [1, 1, 1])];
    const header = Buffer.alloc(34 + name.length);
    [0, translationRange, -1, qRange, 0, sRange].forEach((number, index) => header.writeFloatLE(number, index * 4));
    header.writeUInt16LE(frames, 24);
    [translation.length, rotation.length, scale.length].forEach((count, index) => header.writeUInt16LE(count, 26 + index * 2));
    header[33] = name.length;
    header.write(name, 34, name.length, 'ascii');
    headers.push(header);
    data.push(encode(translation, 3, 0, translationRange), encode(scale, 3, 0, sRange), encode(rotation, 4, -1, qRange));
  }
  const fpsBytes = Buffer.alloc(4);
  fpsBytes.writeUInt32LE(fps);
  const body = Buffer.concat([chunk('FPS\0', fpsBytes), chunk('HEAD', Buffer.concat(headers)), chunk('DATA', Buffer.concat(data))]);
  const container = Buffer.alloc(20);
  container.write('FORM', 0);
  container.writeUInt32BE(body.length + 12, 4);
  container.write('ANIMSET6', 8);
  container.writeUInt32BE(body.length, 16);
  return Buffer.concat([container, body]);
}

function makeReport() {
  return {
    rootBone: 'Root', pelvisBone: 'Pelvis', boneCount: 64, numFrames: 4, fps: 30,
    keys: originalRoot.map(({ frame, value }) => ({
      frames: [frame], originalRoot: [...value], originalPelvis: [0, 0, 0],
      newRoot: [...migratedRoot[frame].value], newPelvis: [...migratedPelvis[frame].value],
    })),
  };
}

function fixture() {
  const originalBuffer = makeAnm();
  return {
    candidateBuffer: makeAnm({ root: migratedRoot, pelvis: migratedPelvis }),
    controlBuffer: Buffer.from(originalBuffer), originalBuffer,
    expectedOriginalSha256: hash(originalBuffer), expectedControlSha256: hash(originalBuffer), expectedBones: [...bones], migrationReport: makeReport(),
  };
}

function modifyHeader(buffer, bone, offset, write) {
  const result = Buffer.from(buffer), record = parseAnmSet6(result).records.find(item => item.name === bone);
  write(result, record.headerOffset + offset);
  return result;
}

test('valid native pair proves bounded numerical invariants without mutating input or claiming gameplay', () => {
  const input = fixture(), saved = [input.originalBuffer, input.controlBuffer, input.candidateBuffer].map(Buffer.from);
  const result = validateNativeAnimation(input);
  assert.equal(result.status, 'native-structure-and-translations-verified');
  assert.equal(result.baselineSourceAttested, true);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.gameplayValidated, false);
  assert.equal(result.unchangedBones, 62);
  assert.equal(result.boneCount, 64);
  assert.equal(result.candidateTranslationQuantizationSourceBound, true);
  assert.deepEqual(result.candidateTranslationQuantization.map(q => [q.min, q.range, q.exactMatch]), [[0, 3, true], [0, 3, true]]);
  assert.equal(result.checkedSourceFrames, 4);
  assert.equal(result.rootCurveEquivalence.checkedSourceFrames, 4);
  assert.equal(result.rootCurveEquivalence.maxRemappedControlError, 0);
  assert.equal(result.originalSha256, input.expectedOriginalSha256);
  assert.equal(result.candidateSha256, hash(input.candidateBuffer));
  assert.equal(Object.hasOwn(result, 'fps'), false);
  assert.deepEqual(result.frameRateMetadata, { sourceFps: 30, encodedFps: 30, matchesSource: true });
  [input.originalBuffer, input.controlBuffer, input.candidateBuffer].forEach((bytes, index) => assert.deepEqual(bytes, saved[index]));
});

test('numerically valid comparisons remain unresolved without an attested control digest', () => {
  const input = fixture();
  delete input.expectedControlSha256;
  const result = validateNativeAnimation(input);
  assert.equal(result.status, 'native-comparison-baseline-unattested');
  assert.equal(result.baselineSourceAttested, false);
  assert.equal(result.gameplayValidated, false);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.rootCurveEquivalence.maxRemappedControlError, 0);
});

test('a swapped control and matching transformed candidate cannot satisfy a different attested baseline', () => {
  const input = fixture();
  input.controlBuffer = makeAnm({ root: track([[0, 0, 0], [0, 0.5, 0], [0, 1, 0], [0, 1.5, 0]]) });
  input.candidateBuffer = makeAnm({ root: track([[0, 0, 0], [0, 0, 0.5], [0, 0, 1], [0, 0, 1.5]]), pelvis: migratedPelvis });
  assert.throws(() => validateNativeAnimation(input), /native control SHA-256 does not match the attested source baseline/);
  delete input.expectedControlSha256;
  const result = validateNativeAnimation(input);
  assert.equal(result.rootCurveEquivalence.maxRemappedControlError, 0);
  assert.equal(result.baselineSourceAttested, false);
  assert.equal(result.status, 'native-comparison-baseline-unattested');
  assert.ok(result.checks.find(item => item.kind === 'control' && item.bone === 'Root').maxSourceFrameError > 1);
  input.expectedControlSha256 = 'not a digest';
  assert.throws(() => validateNativeAnimation(input), /expectedControlSha256 must be a trusted per-clip/);
});

test('original Buffer, trusted digest, and canonical bone inventory are mandatory', () => {
  for (const key of ['originalBuffer', 'expectedOriginalSha256', 'expectedBones']) {
    const input = fixture();
    delete input[key];
    assert.throws(() => validateNativeAnimation(input), /Buffer|SHA-256|expectedBones/);
  }
  const input = fixture();
  input.expectedOriginalSha256 = '0'.repeat(64);
  assert.throws(() => validateNativeAnimation(input), /original ANM SHA-256 does not match/);
});

test('changing Q/S quantization headers is rejected even with identical encoded channel bytes', () => {
  for (const bone of ['Root', 'Pelvis']) for (const relative of [8, 12, 16, 20]) {
    const input = fixture(), before = parseAnmSet6(input.candidateBuffer).records.find(record => record.name === bone);
    input.candidateBuffer = modifyHeader(input.candidateBuffer, bone, relative, (bytes, offset) => bytes.writeFloatLE(bytes.readFloatLE(offset) + 0.125, offset));
    const after = parseAnmSet6(input.candidateBuffer).records.find(record => record.name === bone);
    assert.deepEqual(after.q, before.q);
    assert.deepEqual(after.s, before.s);
    assert.throws(() => validateNativeAnimation(input), /immutable frame, rotation or scale metadata/);
  }
});

test('changed Root/Pelvis Q/S values and unrelated bone DATA are rejected', () => {
  for (const [bone, channel] of [['Root', 'q'], ['Pelvis', 's'], ['Joint_00', 't']]) {
    const input = fixture(), record = parseAnmSet6(input.candidateBuffer).records.find(item => item.name === bone);
    const target = record[channel];
    target.writeUInt16LE((target.readUInt16LE(2) + 1) % 65536, 2);
    assert.throws(() => validateNativeAnimation(input), /rotation\/scale bytes|unrelated bone HEAD\/DATA/);
  }
});

test('Q/S key counts must remain identical even when extra keys have the same value', () => {
  for (const changed of [
    { rootRotation: [xyz(0, [0, 0, 0, 1]), xyz(3, [0, 0, 0, 1])] },
    { rootScale: [xyz(0, [1, 1, 1]), xyz(3, [1, 1, 1])] },
  ]) {
    const input = fixture();
    input.candidateBuffer = makeAnm({ root: migratedRoot, pelvis: migratedPelvis, ...changed });
    assert.throws(() => validateNativeAnimation(input), /immutable frame, rotation or scale metadata/);
  }
});

test('missing, renamed and reordered bones cannot satisfy the canonical inventory', () => {
  for (const names of [bones.slice(0, 63), [...bones.slice(0, 63), 'OtherJoint'], [bones[1], bones[0], ...bones.slice(2)]]) {
    const input = fixture();
    input.candidateBuffer = makeAnm({ names, root: migratedRoot, pelvis: migratedPelvis });
    assert.throws(() => validateNativeAnimation(input), /bone names\/order/);
  }
  const input = fixture();
  input.expectedBones[63] = input.expectedBones[62];
  assert.throws(() => validateNativeAnimation(input), /64 unique canonical/);
});

test('canonical frame count and immutable native metadata are checked against the original', () => {
  const frames = fixture();
  frames.candidateBuffer = makeAnm({ frames: 5, root: migratedRoot, pelvis: migratedPelvis });
  assert.throws(() => validateNativeAnimation(frames), /frame metadata differs/);
  const fps = fixture();
  fps.candidateBuffer = makeAnm({ fps: 32, root: migratedRoot, pelvis: migratedPelvis });
  fps.controlBuffer = makeAnm({ fps: 32 });
  delete fps.expectedControlSha256;
  assert.throws(() => validateNativeAnimation(fps), /immutable container metadata differs/);
});

test('TXA frame rate must match original and native FPS metadata', () => {
  for (const fps of [32, 60]) {
    const input = fixture();
    input.migrationReport.fps = fps;
    assert.throws(() => validateNativeAnimation(input), /original FPS metadata differs from the TXA/);
  }
  for (const fps of [undefined, NaN, 0, 30.5, 241]) {
    const input = fixture();
    input.migrationReport.fps = fps;
    assert.throws(() => validateNativeAnimation(input), /FPS must match the supported integer/);
  }
});

test('different Root key times fail even when the represented linear curve is equal', () => {
  const input = fixture();
  input.candidateBuffer = makeAnm({ root: [migratedRoot[0], migratedRoot[3]], pelvis: migratedPelvis });
  assert.throws(() => validateNativeAnimation(input), /native Root key times differ/);
});

test('Root axis error and Pelvis source error fail the quantization bounds', () => {
  const root = fixture();
  root.candidateBuffer = makeAnm({ root: originalRoot, pelvis: migratedPelvis });
  assert.throws(() => validateNativeAnimation(root), /native Root differs from remapped control at source frame 1/);
  const pelvis = fixture();
  pelvis.candidateBuffer = makeAnm({ root: migratedRoot, pelvis: originalPelvis });
  assert.throws(() => validateNativeAnimation(pelvis), /candidate Pelvis differs from TXA source at frame 1/);
});

test('zeroed candidate motion cannot buy a larger error allowance by inflating its own range', () => {
  for (const bone of ['Root', 'Pelvis']) {
    const input = fixture(), record = parseAnmSet6(input.candidateBuffer).records.find(r => r.name === bone);
    // This formerly passed: unchanged keys/Q/S plus min=0, range=1e6 makes
    // a completely zero translation curve fit a candidate-derived 30 m bound.
    input.candidateBuffer.writeFloatLE(1000000, record.headerOffset + 4);
    record.t.fill(0, record.counts[0] * 2);
    assert.ok(parseAnmSet6(input.candidateBuffer).records.find(r => r.name === bone).translation.every(key => key.value.every(value => value === 0)));
    assert.throws(() => validateNativeAnimation(input), /source-bound translation quantization/);
  }
});

test('source-derived minimum and range are exact bounds, not candidate-supplied tolerances', () => {
  for (const bone of ['Root', 'Pelvis']) for (const [offset, value] of [[0, .00001], [4, 3.00001], [4, 2.99999]]) {
    const input = fixture();
    input.candidateBuffer = modifyHeader(input.candidateBuffer, bone, offset, (bytes, at) => bytes.writeFloatLE(value, at));
    assert.throws(() => validateNativeAnimation(input), /source-bound translation quantization/);
  }
});

test('Root comparison preserves native control simplification and does not label it new conversion error', () => {
  const input = fixture();
  const controlKeys = [xyz(0, [0, 0, 0]), xyz(3, [0, 2.9, 0])];
  const candidateKeys = [xyz(0, [0, 0, 0]), xyz(3, [0, 0, 2.9])];
  input.controlBuffer = makeAnm({ root: controlKeys });
  input.expectedControlSha256 = hash(makeAnm({ root: controlKeys }));
  input.candidateBuffer = makeAnm({ root: candidateKeys, pelvis: migratedPelvis });
  const result = validateNativeAnimation(input);
  assert.equal(result.rootCurveEquivalence.maxRemappedControlError, 0);
  assert.equal(result.checks.find(item => item.kind === 'candidate' && item.bone === 'Root').withinPureQuantization, false);
  assert.equal(result.gameplayValidated, false);
});

test('frame ranges are expanded and checked including the final frame', () => {
  const input = fixture();
  input.migrationReport.keys[2].frames = [2, 3];
  input.migrationReport.keys.pop();
  input.controlBuffer = makeAnm({ root: originalRoot.slice(0, 3), translationRange: 2 });
  input.expectedControlSha256 = hash(input.controlBuffer);
  input.candidateBuffer = makeAnm({ root: migratedRoot.slice(0, 3), pelvis: migratedPelvis.slice(0, 3), translationRange: 2 });
  const result = validateNativeAnimation(input);
  assert.equal(result.checkedSourceFrames, 4);
  // With range=2, the midpoint 1 is between two uint16 codes; allow one code
  // step rather than incorrectly demanding an exactly representable midpoint.
  assert.ok(result.checks.find(item => item.kind === 'candidate' && item.bone === 'Pelvis').maxSourceFrameError <= 2 / 65535);
});

test('incomplete, overlapping, nonfinite or tampered migration reports fail before acceptance', () => {
  for (const mutate of [
    report => { report.keys.pop(); },
    report => { report.keys[1].frames = [0]; },
    report => { report.keys[1].newRoot[0] = NaN; },
    report => { report.keys[1].newPelvis[1] += 0.1; },
    report => { report.pelvisBone = report.rootBone; },
  ]) {
    const input = fixture();
    mutate(input.migrationReport);
    assert.throws(() => validateNativeAnimation(input), /source frame coverage|invalid newRoot|does not implement|distinct canonical/);
  }
});

test('truncated, corrupt and duplicate-key native inputs fail closed', () => {
  const truncated = fixture();
  truncated.candidateBuffer = truncated.candidateBuffer.subarray(0, -1);
  assert.throws(() => validateNativeAnimation(truncated), /container sizes/);
  const corrupt = fixture();
  corrupt.candidateBuffer.write('FAIL', 0);
  assert.throws(() => validateNativeAnimation(corrupt), /container signature/);
  const duplicate = fixture(), root = parseAnmSet6(duplicate.candidateBuffer).records[0];
  root.t.writeUInt16LE(0, 2);
  assert.throws(() => validateNativeAnimation(duplicate), /unordered key frames/);
});
