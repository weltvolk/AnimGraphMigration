import { createHash } from 'node:crypto';

/** Limits for the observed, uncompressed SET6 layout; not a general ANM codec. */
export const ANM_SET6_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxBones: 512,
  maxFrames: 10000,
  maxFps: 240,
  maxTotalKeys: 100000,
});

export class AnmSet6Error extends Error {
  constructor(message, source) {
    super(`${source}: unsupported or invalid ANIMSET6: ${message}`);
    this.name = 'AnmSet6Error';
    this.source = source;
  }
}

/**
 * Read the bounded FORM/ANIM/SET6, FPS\0/HEAD/DATA layout from a Buffer.
 * Never modifies the input or writes files. Returned header/data/channel views
 * share the input Buffer: callers must keep it unchanged while using results.
 * T/Q/S values are decoded without assuming a skeleton or normalizing values.
 */
export function parseAnmSet6(buffer, { source = '<ANM>' } = {}) {
  if (typeof source !== 'string' || !source) throw new TypeError('source must be a nonempty diagnostic label');
  const fail = message => { throw new AnmSet6Error(message, source); };
  if (!Buffer.isBuffer(buffer)) fail('expected a Buffer');
  const b = buffer;
  if (b.length < 20 || b.length > ANM_SET6_LIMITS.maxBytes) fail('file size outside the supported bounds');
  if (!b.subarray(0, 4).equals(Buffer.from('FORM')) || !b.subarray(8, 16).equals(Buffer.from('ANIMSET6'))) fail('unexpected container signature');
  if (b.readUInt32BE(4) + 8 !== b.length || b.readUInt32BE(16) + 20 !== b.length) fail('container sizes do not cover the complete file');

  const required = new Set(['FPS\0', 'HEAD', 'DATA']);
  const chunks = [], byId = new Map();
  let offset = 20;
  while (offset < b.length) {
    if (b.length - offset < 8) fail('truncated chunk header');
    const id = b.toString('latin1', offset, offset + 4);
    const bytes = b.readUInt32BE(offset + 4), start = offset + 8;
    if (!required.has(id)) fail(`unsupported chunk ${JSON.stringify(id)}`);
    if (byId.has(id)) fail(`duplicate chunk ${JSON.stringify(id)}`);
    if (bytes > b.length - start) fail('chunk exceeds the container');
    const chunk = { id, start, bytes, data: b.subarray(start, start + bytes) };
    chunks.push(chunk);
    byId.set(id, chunk);
    offset = start + bytes;
  }
  if (chunks.length !== required.size || [...required].some(id => !byId.has(id))) fail('required FPS, HEAD or DATA chunk missing');
  const fpsChunk = byId.get('FPS\0');
  if (fpsChunk.bytes !== 4) fail('FPS chunk must contain one uint32');
  const fps = b.readUInt32LE(fpsChunk.start);
  if (fps < 1 || fps > ANM_SET6_LIMITS.maxFps) fail('frame rate outside the supported bounds');

  const head = byId.get('HEAD'), data = byId.get('DATA');
  const headEnd = head.start + head.bytes, dataEnd = data.start + data.bytes;
  const records = [], names = new Set();
  let h = head.start, d = data.start, numFrames = null, totalKeys = 0;

  // Validate every record and its size before allocating decoded key arrays.
  while (h < headEnd) {
    if (records.length >= ANM_SET6_LIMITS.maxBones) fail('bone count exceeds the supported limit');
    if (headEnd - h < 34) fail('truncated bone header');
    const nameBytes = b[h + 33], recordBytes = 34 + nameBytes;
    if (nameBytes === 0 || recordBytes > headEnd - h) fail('empty or truncated bone name');
    const rawName = b.subarray(h + 34, h + recordBytes);
    if (rawName.some(byte => byte < 32 || byte > 126)) fail('bone names must be printable ASCII');
    const name = rawName.toString('ascii');
    if (names.has(name)) fail(`duplicate bone name ${JSON.stringify(name)}`);
    names.add(name);
    if (b[h + 32] !== 0) fail(`unsupported bone encoding for ${name}`);

    const frames = b.readUInt16LE(h + 24);
    if (frames < 1 || frames > ANM_SET6_LIMITS.maxFrames) fail(`invalid frame count for ${name}`);
    if (numFrames !== null && frames !== numFrames) fail('bone frame counts disagree');
    numFrames = frames;
    const counts = [26, 28, 30].map(relative => b.readUInt16LE(h + relative));
    if (counts.some(count => count < 1 || count > frames)) fail(`missing or excessive channel keys for ${name}`);
    totalKeys += counts.reduce((sum, count) => sum + count, 0);
    if (totalKeys > ANM_SET6_LIMITS.maxTotalKeys) fail('total key count exceeds the supported limit');

    const quantization = {};
    for (const [channel, relative] of [['t', 0], ['q', 8], ['s', 16]]) {
      const min = b.readFloatLE(h + relative), range = b.readFloatLE(h + relative + 4);
      if (!Number.isFinite(min) || !Number.isFinite(range) || range < 0) fail(`invalid ${channel} quantization for ${name}`);
      quantization[channel] = { min, range, header: b.subarray(h + relative, h + relative + 8) };
    }

    // Data order is translation, scale, quaternion; HEAD counts are T, Q, S.
    const [tCount, qCount, sCount] = counts;
    const tBytes = tCount * 8, sBytes = sCount * 8, qBytes = qCount * 10;
    const bytes = tBytes + sBytes + qBytes;
    if (bytes > dataEnd - d) fail(`truncated channel data for ${name}`);
    records.push({
      name, frames, counts, headerOffset: h, header: b.subarray(h, h + recordBytes),
      dataOffset: d, data: b.subarray(d, d + bytes),
      t: b.subarray(d, d + tBytes), s: b.subarray(d + tBytes, d + tBytes + sBytes),
      q: b.subarray(d + tBytes + sBytes, d + bytes),
      minT: quantization.t.min, rangeT: quantization.t.range, quantization,
    });
    h += recordBytes;
    d += bytes;
  }
  if (!records.length || h !== headEnd || d !== dataEnd) fail('empty or incomplete HEAD/DATA coverage');

  function decode(bytes, count, components, quantization, frames, label) {
    const keys = [];
    let previousFrame = -1;
    for (let i = 0; i < count; i++) {
      const frame = bytes.readUInt16LE(2 * i);
      if (frame >= frames || frame <= previousFrame || (i === 0 && frame !== 0)) fail(`invalid or unordered key frames for ${label}`);
      previousFrame = frame;
      const value = [];
      for (let component = 0; component < components; component++) {
        const encoded = bytes.readUInt16LE(count * 2 + (i * components + component) * 2);
        const decoded = quantization.min + quantization.range * encoded / 65535;
        if (!Number.isFinite(decoded)) fail(`non-finite decoded value for ${label}`);
        value.push(decoded);
      }
      keys.push({ frame, value });
    }
    return keys;
  }
  for (const record of records) {
    record.translation = decode(record.t, record.counts[0], 3, record.quantization.t, record.frames, `${record.name}/T`);
    record.quaternion = decode(record.q, record.counts[1], 4, record.quantization.q, record.frames, `${record.name}/Q`);
    record.scale = decode(record.s, record.counts[2], 3, record.quantization.s, record.frames, `${record.name}/S`);
  }
  return { source, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex'), fps, numFrames, records, chunks, fullCoverage: true };
}
