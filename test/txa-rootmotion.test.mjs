import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrateRootMotionTxa, restoreOriginalTxa, ROOT_MOTION_PROFILE_ID, ROOT_MOTION_LIMITS, TxaRootMotionError } from '../src/txa-rootmotion.mjs';

// Entirely invented motion and joint names; no external files are required.
function fixture({ specs = [[0], [1], [2]], pelvisSpecs = specs, numFrames = 3, fps = 30, extraRootChild = false, newline = '\n' } = {}) {
  const rootT = [[0, 0.0011578, 0], [0.2, 0.5011578, -0.3], [0.5, 1.0011578, -0.6]];
  const pelvisT = [[0, 0.1, 0.2], [0.4, 0.15, 0.61], [0.2, -0.01, 0.31]];
  function frames(layout, translations, root = false) {
    return layout.map((spec, index) => `     $frame ${spec.join(' ')} {
      #t ${translations[index].join(' ')} // retain translation comment
${index === 0 ? `      #q ${root ? '-0.7071068 0 0 0.7071068' : '0 0 0 1'}
      #s 0.2002 0.2002 0.2002
` : ''}     }`).join('\n');
  }
  const otherBones = Array.from({ length: 60 }, (_, i) => `     $node "invented_joint_${i}" {
      $keys t q s {
       $frame 0 ${numFrames - 1} {
        #t 0.003 0.004 0.005
        #q 0 0 0 1
       }
      }
     }`);
  const outside = extraRootChild ? otherBones.shift() : '';
  return `// Entirely invented fixture. Preserve this comment exactly.
$animation "synthetic" {
 #version 1.0
 #fps ${fps}
 #numFrames ${numFrames}
 $node "Scene_Root" {
  $keys t q s {
   $frame 0 ${numFrames - 1} {
   }
  }
  $node "Armature" {
   $keys t q s {
    $frame 0 ${numFrames - 1} {
     #s 0.2002 0.2002 0.2002
    }
   }
   $node "entityposition" {
    $keys t q s {
${frames(specs, rootT, true)}
    }
    $node "blackbird_Pelvis_bone" {
     $keys t q s {
${frames(pelvisSpecs, pelvisT)}
     }
${otherBones.join('\n')}
    }
${outside}
   }
  }
 }
}
`.replaceAll('\n', newline);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function quaternionRotate(v, q) {
  const twiceCross = cross(q.slice(0, 3), v).map(x => x * 2);
  const secondCross = cross(q.slice(0, 3), twiceCross);
  return v.map((x, i) => x + q[3] * twiceCross[i] + secondCross[i]);
}
const near = (a, b, tolerance = 2.1e-7) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) <= tolerance), `${a} differs from ${b}`);

test('bounded TXA remaps all displacement axes and independently preserves the Root/Pelvis pose', () => {
  const result = migrateRootMotionTxa(fixture(), { source: 'synthetic basis' });
  assert.deepEqual(result.report.keys[1].newRoot, [0.2, 0.3011578, 0.5]);
  assert.deepEqual(result.report.keys[1].newPelvis, [0.4, 0.95, 0.81]);
  const q = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  for (const key of result.report.keys) {
    const before = quaternionRotate(key.originalPelvis, q).map((x, i) => x + key.originalRoot[i]);
    const after = quaternionRotate(key.newPelvis, q).map((x, i) => x + key.newRoot[i]);
    near(before, after);
  }
  assert.deepEqual(result.report.keys[0].newRoot, result.report.keys[0].originalRoot);
  assert.deepEqual(result.report.keys[0].newPelvis, result.report.keys[0].originalPelvis);
  assert.equal(result.report.rootBone, 'entityposition');
  assert.equal(result.report.pelvisBone, 'blackbird_Pelvis_bone');
  assert.equal(result.report.boneNames.length, 64);
  assert.equal(new Set(result.report.boneNames).size, 64);
});

test('bounded TXA preserves inclusive final frame ranges and the original 32/60 FPS', () => {
  for (const fps of [32, 60]) {
    const source = fixture({ specs: [[0], [1], [2, 3]], numFrames: 4, fps });
    const result = migrateRootMotionTxa(source);
    assert.deepEqual(result.report.frameBlocks.at(-1), { start: 2, end: 3, spec: [2, 3] });
    assert.equal((result.text.match(/\$frame 2 3/g) ?? []).length, 2);
    assert.equal(result.report.keys.length, 3);
    assert.equal(result.report.fps, fps);
    assert.equal(result.report.numFrames, 4);
    assert.match(result.text, new RegExp(`#fps ${fps}`));
  }
});

test('bounded TXA preserves CRLF, comments, all unrelated bytes and the complete first frame', () => {
  const source = fixture({ newline: '\r\n' });
  const result = migrateRootMotionTxa(source);
  const beforeLines = source.split(/(?<=\n)/), afterLines = result.text.split(/(?<=\n)/);
  const changedLines = new Map(result.report.changes.map(change => [change.line - 1, change]));
  assert.equal(changedLines.size, 4);
  assert.equal(beforeLines.length, afterLines.length);
  for (let i = 0; i < beforeLines.length; i++) {
    if (!changedLines.has(i)) assert.equal(afterLines[i], beforeLines[i]);
    else {
      assert.ok(afterLines[i].endsWith('// retain translation comment\r\n'));
      assert.equal(changedLines.get(i).originalLine, beforeLines[i]);
      afterLines[i] = changedLines.get(i).originalLine;
    }
  }
  assert.equal(afterLines.join(''), source);
  assert.ok(result.report.frameZeroUnchanged && result.report.exactReversalVerified);
  assert.ok(result.report.nonTranslationStructureAndTokensUnchanged);
});

test('bounded TXA reports provenance and import requirements without claiming runtime validation', () => {
  const source = fixture();
  const result = migrateRootMotionTxa(source);
  const sha = text => createHash('sha256').update(text).digest('hex');
  assert.equal(result.report.profileId, ROOT_MOTION_PROFILE_ID);
  assert.equal(result.report.sourceSha256, sha(source));
  assert.equal(result.report.outputSha256, sha(result.text));
  assert.equal(result.report.requiresVerifiedOriginal, true);
  assert.equal(result.report.sourceProvenanceVerified, false);
  assert.equal(result.report.nativeImportRequired, true);
  assert.equal(result.report.runtimeValidated, false);
  assert.match(result.report.limitations.join('\n'), /Not idempotent/);
  assert.deepEqual(migrateRootMotionTxa(source), result);
});

test('bounded TXA rejects unsupported or varying quaternion and export scales', () => {
  const source = fixture();
  assert.throws(() => migrateRootMotionTxa(source.replace('-0.7071068 0 0 0.7071068', '0 0 0 1')), /Root quaternion/);
  assert.throws(() => migrateRootMotionTxa(source.replace('#t 0.2 0.5011578 -0.3 // retain translation comment', '#t 0.2 0.5011578 -0.3\n      #q 0 0 0 1')), /Root quaternion/);
  assert.throws(() => migrateRootMotionTxa(source.replace('#s 0.2002 0.2002 0.2002', '#s 1 1 1')), /Armature scale/);
  const rootStart = source.indexOf('$node "entityposition"');
  const changedRoot = source.slice(0, rootStart) + source.slice(rootStart).replace('#s 0.2002 0.2002 0.2002', '#s 1 1 1');
  assert.throws(() => migrateRootMotionTxa(changedRoot), /Root scale/);
});

test('bounded TXA rejects extra Root children, changed parent chain and missing/duplicate bones', () => {
  const source = fixture();
  assert.throws(() => migrateRootMotionTxa(fixture({ extraRootChild: true })), /sole direct child/);
  assert.throws(() => migrateRootMotionTxa(source.replace('"Armature"', '"DifferentParent"')), /sole direct child/);
  assert.throws(() => migrateRootMotionTxa(source.replace('"invented_joint_1"', '"invented_joint_0"')), /duplicate bone/);
  assert.throws(() => migrateRootMotionTxa(source.replace('$node "invented_joint_0" {', '$node "extra_bone" {\n $keys t q s {\n }\n}\n$node "invented_joint_0" {')), /expected 64 bones/);
});

test('bounded TXA rejects missing, duplicate and non-finite translation channels', () => {
  const source = fixture(), target = '#t 0.2 0.5011578 -0.3 // retain translation comment';
  assert.throws(() => migrateRootMotionTxa(source.replace(target, '// missing')), /missing or duplicate #t/);
  assert.throws(() => migrateRootMotionTxa(source.replace(target, `${target}\n      #t 1 2 3`)), /duplicate field #t/);
  for (const invalid of ['NaN', 'Infinity', '1e999', '0x10']) assert.throws(() => migrateRootMotionTxa(source.replace(target, `#t ${invalid} 1 2`)), /non-finite or invalid/);
  assert.throws(() => migrateRootMotionTxa(source.replace(target, '#t 1e15 1 2')), /translation exceeds/);
});

test('bounded TXA rejects gaps, overlaps and different Root/Pelvis frame layouts', () => {
  assert.throws(() => migrateRootMotionTxa(fixture({ specs: [[0], [2]], numFrames: 3 })), /coverage/);
  assert.throws(() => migrateRootMotionTxa(fixture({ specs: [[0], [1]], numFrames: 3 })), /coverage/);
  assert.throws(() => migrateRootMotionTxa(fixture({ specs: [[0, 1], [1, 2]] })), /coverage/);
  assert.throws(() => migrateRootMotionTxa(fixture({ specs: [[0], [1], [2]], pelvisSpecs: [[0], [1, 2]] })), /specifications differ/);
  assert.throws(() => migrateRootMotionTxa(fixture({ specs: [[0], [1], [2, 3]], numFrames: 3 })), /frame specification/);
});

test('bounded TXA rejects unknown fields and malformed syntax rather than repairing it', () => {
  const source = fixture();
  assert.throws(() => migrateRootMotionTxa(source.replace('#fps 30', '#fps 30\n #unknown 1')), /unsupported field #unknown/);
  assert.throws(() => migrateRootMotionTxa(source.replace('#q 0 0 0 1', '#unknown 0 0 0 1')), /unsupported field #unknown/);
  assert.throws(() => migrateRootMotionTxa(source.replace('#fps 30', '#fps 30 {\n }')), /expected scalar/);
  assert.throws(() => migrateRootMotionTxa(source + '}\n'), /Unexpected closing brace/);
  assert.throws(() => migrateRootMotionTxa(source + '\0'), /NUL/);
});

test('bounded TXA enforces input/frame/FPS limits and preserves diagnostic source labels', () => {
  assert.throws(() => migrateRootMotionTxa(null), TxaRootMotionError);
  assert.throws(() => migrateRootMotionTxa(' '.repeat(ROOT_MOTION_LIMITS.maxBytes + 1)), /8 MiB/);
  for (const fps of [0, -1, 240.5, 241]) assert.throws(() => migrateRootMotionTxa(fixture({ fps })), /frame rate/);
  assert.throws(() => migrateRootMotionTxa(fixture({ numFrames: 10001 })), /frame count/);
  assert.throws(() => migrateRootMotionTxa(fixture(), { source: '' }), TypeError);
  assert.throws(() => migrateRootMotionTxa(fixture().replace('#version 1.0', '#version 2'), { source: 'synthetic-case' }), error => error instanceof TxaRootMotionError && error.source === 'synthetic-case');
});

test('TXA restoration recreates exact LF/CRLF originals including comments without mutation', () => {
  for (const newline of ['\n', '\r\n']) {
    const original = fixture({ newline, specs: [[0], [1], [2, 3]], numFrames: 4 });
    const prepared = migrateRootMotionTxa(original, { source: 'synthetic/Walk.txa' });
    const before = structuredClone(prepared);
    assert.equal(restoreOriginalTxa(prepared.text, prepared.report), original);
    assert.deepEqual(prepared, before);
  }
});

test('TXA restoration rejects altered prepared data or either source/output digest', () => {
  const prepared = migrateRootMotionTxa(fixture());
  assert.throws(() => restoreOriginalTxa(prepared.text + '// appended\n', prepared.report), /output SHA-256 mismatch/);
  for (const field of ['sourceSha256', 'outputSha256']) {
    const report = structuredClone(prepared.report);
    report[field] = '0'.repeat(64);
    assert.throws(() => restoreOriginalTxa(prepared.text, report), /SHA-256 mismatch/);
    report[field] = 'invalid';
    assert.throws(() => restoreOriginalTxa(prepared.text, report), new RegExp(field));
  }
});

test('TXA restoration requires exact unique in-range patch lines and single translation lines', () => {
  const prepared = migrateRootMotionTxa(fixture());
  for (const change of [
    report => { report.changes.push({ ...report.changes[0] }); },
    report => { report.changes[0].line = 0; },
    report => { report.changes[0].line = 10000000; },
    report => { report.changes[0].line = 1.5; },
    report => { report.changes[0].newLine = ' #t 9 9 9\n'; },
    report => { report.changes[0].originalLine += ' #t 1 2 3\n'; },
    report => { report.changes[0].originalLine += '\n'; },
    report => { report.changes[0].originalLine = ' #q 0 0 0 1\n'; },
    report => { report.changes[0].bone = 'invented_joint_0'; },
  ]) {
    const report = structuredClone(prepared.report);
    change(report);
    assert.throws(() => restoreOriginalTxa(prepared.text, report), /cannot restore original/);
  }
});

test('TXA restoration independently recomputes report keys, bone/frame facts and transformation rules', () => {
  const prepared = migrateRootMotionTxa(fixture());
  for (const change of [
    report => { report.keys[1].newRoot[0] += 1; },
    report => { report.keys[1].originalPelvis[2] += 1; },
    report => { report.frameBlocks[0].end = 1; },
    report => { report.boneNames[4] = 'forged_bone'; },
    report => { report.fps = 60; },
    report => { report.rootBone = report.pelvisBone; },
    report => { report.numFrames = 200; },
    report => { report.rule = 'forged operation'; },
    report => { report.changes.reverse(); },
  ]) {
    const report = structuredClone(prepared.report);
    change(report);
    assert.throws(() => restoreOriginalTxa(prepared.text, report), /differs from the repeated transformation/);
  }
});

test('TXA restoration refuses an otherwise hash-consistent report for another operation', () => {
  const original = fixture(), prepared = migrateRootMotionTxa(original);
  const report = structuredClone(prepared.report);
  report.outputSha256 = report.sourceSha256;
  report.changes = [];
  assert.throws(() => restoreOriginalTxa(original, report), /forward transformation does not reproduce/);
});

test('TXA restoration rejects absent/unsupported reports and excessive input', () => {
  const prepared = migrateRootMotionTxa(fixture());
  for (const report of [null, [], {}, { ...prepared.report, source: '' }, { ...prepared.report, profileId: 'generic' }]) assert.throws(() => restoreOriginalTxa(prepared.text, report), /migration report/);
  assert.throws(() => restoreOriginalTxa(null, prepared.report), /prepared text/);
  assert.throws(() => restoreOriginalTxa(' '.repeat(ROOT_MOTION_LIMITS.maxBytes + 1), prepared.report), /bounds/);
  assert.throws(() => restoreOriginalTxa(prepared.text, { ...prepared.report, changes: Array(ROOT_MOTION_LIMITS.maxFrames * 2 + 1).fill(null) }), /reverse-patch list/);
});
