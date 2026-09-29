import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAnmSet6, ANM_SET6_LIMITS, AnmSet6Error } from '../src/anm-set6.mjs';

// Synthetic buffers built from invented values; this suite reads no asset files.
function bone({ name = 'InventedRoot', frames = 4, keyFrames = [0, 3], qFrames = [0], sFrames = [0], reserved = 0 } = {}) {
  const nameBytes = Buffer.from(name, 'ascii');
  const header = Buffer.alloc(34 + nameBytes.length);
  for (const [at, min, range] of [[0, -1, 4], [8, -1, 2], [16, 0.25, 0.5]]) {
    header.writeFloatLE(min, at);
    header.writeFloatLE(range, at + 4);
  }
  header.writeUInt16LE(frames, 24);
  [keyFrames.length, qFrames.length, sFrames.length].forEach((value, index) => header.writeUInt16LE(value, 26 + index * 2));
  header[32] = reserved;
  header[33] = nameBytes.length;
  nameBytes.copy(header, 34);
  function channel(indices, components) {
    const output = Buffer.alloc(indices.length * (2 + components * 2));
    indices.forEach((frame, index) => {
      output.writeUInt16LE(frame, index * 2);
      for (let component = 0; component < components; component++) {
        const encoded = index === 0 ? (component === components - 1 ? 65535 : 0) : 32768;
        output.writeUInt16LE(encoded, indices.length * 2 + (index * components + component) * 2);
      }
    });
    return output;
  }
  return { header, data: Buffer.concat([channel(keyFrames, 3), channel(sFrames, 3), channel(qFrames, 4)]) };
}

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'latin1');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
function container(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(20);
  header.write('FORM', 0, 'ascii');
  header.writeUInt32BE(body.length + 12, 4);
  header.write('ANIMSET6', 8, 'ascii');
  header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body]);
}
function fixture(records = [bone()], { fps = 30, suffix = [] } = {}) {
  const rate = Buffer.alloc(4);
  rate.writeUInt32LE(fps);
  return container([
    chunk('FPS\0', rate),
    chunk('HEAD', Buffer.concat(records.map(record => record.header))),
    chunk('DATA', Buffer.concat(records.map(record => record.data))),
    ...suffix,
  ]);
}
const changed = (input, change) => { const result = Buffer.from(input); change(result); return result; };
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-10, `${value} != ${expected}`);

test('SET6 decodes independent T/S/Q channels and FPS without changing input bytes', () => {
  const input = fixture([bone(), bone({ name: 'InventedChild' })], { fps: 60 });
  const before = Buffer.from(input);
  const result = parseAnmSet6(input, { source: 'synthetic.anm' });
  assert.deepEqual(input, before);
  assert.equal(result.source, 'synthetic.anm');
  assert.equal(result.fps, 60);
  assert.equal(result.numFrames, 4);
  assert.equal(result.bytes, input.length);
  assert.equal(result.sha256, createHash('sha256').update(input).digest('hex'));
  assert.equal(result.fullCoverage, true);
  assert.deepEqual(result.chunks.map(item => item.id), ['FPS\0', 'HEAD', 'DATA']);
  assert.deepEqual(result.records.map(record => record.name), ['InventedRoot', 'InventedChild']);
  const record = result.records[0];
  assert.deepEqual(record.counts, [2, 1, 1]);
  assert.deepEqual(record.translation[0], { frame: 0, value: [-1, -1, 3] });
  assert.deepEqual(record.quaternion[0], { frame: 0, value: [-1, -1, -1, 1] });
  assert.deepEqual(record.scale[0], { frame: 0, value: [0.25, 0.25, 0.75] });
  assert.equal(record.translation[1].frame, 3);
  for (const value of record.translation[1].value) near(value, -1 + 4 * 32768 / 65535);
  assert.equal(record.minT, -1);
  assert.equal(record.rangeT, 4);
  assert.ok(record.data.equals(Buffer.concat([record.t, record.s, record.q])));
  assert.ok(record.header.equals(input.subarray(record.headerOffset, record.headerOffset + record.header.length)));
});

test('SET6 exposes the Q/S quantization headers separately from their encoded bytes', () => {
  const original = fixture();
  const first = parseAnmSet6(original);
  const offset = first.records[0].headerOffset;
  const different = changed(original, bytes => { bytes.writeFloatLE(3, offset + 12); bytes.writeFloatLE(0.5, offset + 16); });
  const second = parseAnmSet6(different);
  assert.ok(first.records[0].q.equals(second.records[0].q));
  assert.ok(first.records[0].s.equals(second.records[0].s));
  assert.ok(!first.records[0].quantization.q.header.equals(second.records[0].quantization.q.header));
  assert.ok(!first.records[0].quantization.s.header.equals(second.records[0].quantization.s.header));
  assert.notDeepEqual(first.records[0].quaternion, second.records[0].quaternion);
  assert.notDeepEqual(first.records[0].scale, second.records[0].scale);
});

test('SET6 accepts constant channels and reports header/key values without normalizing them', () => {
  const item = bone({ frames: 1, keyFrames: [0] });
  item.header.writeFloatLE(0, 4);
  item.header.writeFloatLE(0, 12);
  item.header.writeFloatLE(0, 20);
  const result = parseAnmSet6(fixture([item], { fps: 32 }));
  assert.equal(result.fps, 32);
  assert.equal(result.numFrames, 1);
  assert.deepEqual(result.records[0].translation[0].value, [-1, -1, -1]);
  assert.deepEqual(result.records[0].quaternion[0].value, [-1, -1, -1, -1]);
});

test('SET6 rejects signatures, high-bit aliases, invalid sizes and trailing bytes', () => {
  const good = fixture();
  for (const modify of [
    b => { b[0] = 0; },
    b => { b[0] |= 128; },
    b => { b[8] |= 128; },
    b => { b.writeUInt32BE(b.length, 4); },
    b => { b.writeUInt32BE(0xffffffff, 16); },
  ]) assert.throws(() => parseAnmSet6(changed(good, modify)), /signature|sizes/);
  assert.throws(() => parseAnmSet6(Buffer.concat([good, Buffer.from([0])])), /sizes/);
  for (const length of [0, 1, 19]) assert.throws(() => parseAnmSet6(Buffer.alloc(length)), /size/);
});

test('SET6 rejects missing, duplicate, unknown and overflowing chunks', () => {
  const good = fixture(), parsed = parseAnmSet6(good);
  const copies = parsed.chunks.map(item => chunk(item.id, item.data));
  assert.throws(() => parseAnmSet6(container(copies.slice(0, 2))), /missing/);
  assert.throws(() => parseAnmSet6(fixture(undefined, { suffix: [copies[0]] })), /duplicate chunk/);
  assert.throws(() => parseAnmSet6(fixture(undefined, { suffix: [chunk('WHAT', Buffer.alloc(0))] })), /unsupported chunk/);
  assert.throws(() => parseAnmSet6(container([...copies, Buffer.alloc(7)])), /truncated chunk header/);
  assert.throws(() => parseAnmSet6(changed(good, b => b.writeUInt32BE(0xffffffff, 24))), /exceeds/);
  const wrongFpsSize = container([chunk('FPS\0', Buffer.alloc(8)), ...copies.slice(1)]);
  assert.throws(() => parseAnmSet6(wrongFpsSize), /one uint32/);
  assert.throws(() => parseAnmSet6(container(copies.map(item => item.subarray(0, 8)))), AnmSet6Error);
});

test('SET6 rejects incomplete HEAD/DATA coverage and truncated bone records', () => {
  const record = bone();
  assert.throws(() => parseAnmSet6(fixture([])), /coverage/);
  assert.throws(() => parseAnmSet6(fixture([{ ...record, header: record.header.subarray(0, 33) }])), /truncated bone header/);
  assert.throws(() => parseAnmSet6(fixture([{ ...record, header: record.header.subarray(0, -1) }])), /truncated bone name/);
  assert.throws(() => parseAnmSet6(fixture([{ ...record, data: record.data.subarray(0, -1) }])), /truncated channel/);
  assert.throws(() => parseAnmSet6(fixture([{ ...record, data: Buffer.concat([record.data, Buffer.from([0])]) }])), /coverage/);
  assert.throws(() => parseAnmSet6(fixture([{ ...record, header: Buffer.concat([record.header, Buffer.alloc(2)]) }])), /truncated bone header/);
});

test('SET6 rejects duplicate/invalid names and unknown record encoding', () => {
  assert.throws(() => parseAnmSet6(fixture([bone(), bone()])), /duplicate bone/);
  assert.throws(() => parseAnmSet6(fixture([bone({ name: '' })])), /empty/);
  assert.throws(() => parseAnmSet6(fixture([bone({ name: 'bad\0name' })])), /ASCII/);
  assert.throws(() => parseAnmSet6(fixture([bone({ reserved: 1 })])), /encoding/);
  const badName = bone();
  badName.header[34] = 255;
  assert.throws(() => parseAnmSet6(fixture([badName])), /ASCII/);
});

test('SET6 rejects non-finite or negative quantization in each channel', () => {
  for (const position of [0, 4, 8, 12, 16, 20]) {
    for (const value of [NaN, Infinity, -Infinity, ...(position % 8 === 4 ? [-1] : [])]) {
      const record = bone();
      record.header.writeFloatLE(value, position);
      assert.throws(() => parseAnmSet6(fixture([record])), /quantization/);
    }
  }
});

test('SET6 rejects unordered, duplicate, missing-initial and out-of-range keys for T/Q/S', () => {
  for (const field of ['keyFrames', 'qFrames', 'sFrames']) {
    for (const indices of [[0, 3, 2], [0, 0], [1, 3], [0, 4]]) {
      assert.throws(() => parseAnmSet6(fixture([bone({ [field]: indices })])), /key frames/);
    }
    assert.throws(() => parseAnmSet6(fixture([bone({ [field]: [] })])), /channel keys/);
  }
  assert.throws(() => parseAnmSet6(fixture([bone({ keyFrames: [0, 1, 2, 3, 3] })])), /excessive channel/);
});

test('SET6 bounds frame counts/FPS and requires one consistent frame count across bones', () => {
  for (const fps of [0, ANM_SET6_LIMITS.maxFps + 1]) assert.throws(() => parseAnmSet6(fixture(undefined, { fps })), /frame rate/);
  for (const frames of [0, ANM_SET6_LIMITS.maxFrames + 1]) assert.throws(() => parseAnmSet6(fixture([bone({ frames })])), /frame count/);
  assert.throws(() => parseAnmSet6(fixture([bone(), bone({ name: 'Other', frames: 5 })])), /frame counts disagree/);
});

test('SET6 bounds bones, total keys and file bytes before allocating decoded key arrays', () => {
  const tooManyBones = Array.from({ length: ANM_SET6_LIMITS.maxBones + 1 }, (_, index) => bone({ name: `Joint_${index}` }));
  assert.throws(() => parseAnmSet6(fixture(tooManyBones)), /bone count/);
  const indices = Array.from({ length: 1000 }, (_, index) => index);
  const tooManyKeys = Array.from({ length: 34 }, (_, index) => bone({ name: `Joint_${index}`, frames: 1000, keyFrames: indices, qFrames: indices, sFrames: indices }));
  assert.throws(() => parseAnmSet6(fixture(tooManyKeys)), /total key count/);
  assert.throws(() => parseAnmSet6(Buffer.allocUnsafe(ANM_SET6_LIMITS.maxBytes + 1)), /file size/);
});

test('SET6 rejects non-Buffers and preserves the diagnostic source on validation errors', () => {
  for (const value of [null, '', new Uint8Array(20), {}]) assert.throws(() => parseAnmSet6(value), AnmSet6Error);
  assert.throws(() => parseAnmSet6(Buffer.alloc(20), { source: '' }), TypeError);
  assert.throws(() => parseAnmSet6(Buffer.alloc(20), { source: 'synthetic-damaged' }), error => error instanceof AnmSet6Error && error.source === 'synthetic-damaged');
});
