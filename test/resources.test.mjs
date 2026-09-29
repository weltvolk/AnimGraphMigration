import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, child, values } from '../src/syntax.mjs';
import {
  convertTemplate, convertInstance, convertWorkspace, generateMeta,
  deterministicGuid, resourceRef, splitResourceRef,
} from '../src/resources.mjs';

// Synthetic examples only. No game or mod resources are distributed with these tests.
const oldTemplate = `$animsettemplate {
 #ngrouptypes 1
 $groupType {
  #ngroupnames 0
  #nanims 2
  $anims {
   "Idle"
   "Move"
  }
 }
}`;
const oldInstance = `$animsetinstance {
 #template "Example/source.ast"
 #nparents 0
 $animations {
  "Idle" "{0123456789ABCDEF}Example/idle.anm"
  "Move" "Example/move.anm"
 }
}`;
const oldWorkspace = `$animWorkspace {
 #animSetTemplate "Example/old.ast"
 #NanimSetInstances 1
 #animSetInstance "Example/source.asi"
 #previewModel "Example/model.xob"
 #animGraph "Example/source.agr"
}`;
const workspaceOptions = {
  templateRef: '{1234567890ABCDEF}Migrated/template.ast',
  instanceRefs: ['{1234567890ABCDE0}Migrated/instance.asi'],
  graphRef: '{1234567890ABCDE1}Migrated/graph.agr',
  workspaceRef: '{1234567890ABCDE2}Migrated/workspace.aw',
};
const instanceOptions = () => ({ templateRef: 'Migrated/template.ast', qualifySource: convertTemplate(oldTemplate).qualifySource });

test('legacy template becomes explicit group/column and qualifies only declared slots', () => {
  const result = convertTemplate(oldTemplate, { source: 'synthetic.ast' });
  assert.deepEqual(result.slots, ['Default.Default.Idle', 'Default.Default.Move']);
  assert.equal(result.qualifySource('Idle'), 'Default.Default.Idle');
  assert.equal(result.qualifySource('Default.Default.Move'), 'Default.Default.Move');
  assert.throws(() => result.qualifySource('Missing'), /not declared/);
  assert.equal(parseDocument(result.text)[0].head[0].value, 'AnimSetTemplateSource');
  assert.equal(result.warnings.length, 1);
});

test('native template round trip preserves object identity and slots', () => {
  const first = convertTemplate(oldTemplate, { id: 'ABCDABCDABCDABCD' });
  const second = convertTemplate(first.text);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.slots, first.slots);
});

test('template counts, duplicate slots, unknown properties and named legacy groups fail closed', () => {
  assert.throws(() => convertTemplate(oldTemplate.replace('#nanims 2', '#nanims 3')), /count does not match/);
  assert.throws(() => convertTemplate(oldTemplate.replace('"Move"', '"Idle"')), /Duplicate animation/);
  assert.throws(() => convertTemplate(oldTemplate.replace('#ngroupnames 0', '#ngroupnames 1')), /Named legacy groups/);
  assert.throws(() => convertTemplate(oldTemplate.replace('#ngroupnames 0', '#ngroupnames 0\n #unexpected 1')), /Unsupported field/);
  assert.throws(() => convertTemplate(oldTemplate.replace('#nanims 2', '#nanims 2\n #nanims 2')), /Duplicate field/);
  assert.throws(() => convertTemplate(oldTemplate, { group: 'Bad.Group' }), /neither a dot/);
});

test('native multiple groups and columns reject ambiguous bare source names', () => {
  const text = `AnimSetTemplateSource {
 Groups {
  AnimSetTemplateSource_AnimationGroup "{1111111111111111}" {
   Name "Locomotion"
   Animations { "Idle" "Move" }
   Columns { "Slow" "Fast" }
  }
  AnimSetTemplateSource_AnimationGroup "{2222222222222222}" {
   Name "Rest"
   Animations { "Idle" }
   Columns { "Default" }
  }
 }
}`;
  const result = convertTemplate(text);
  assert.equal(result.slots.length, 5);
  assert.equal(result.qualifySource('Locomotion.Fast.Move'), 'Locomotion.Fast.Move');
  assert.throws(() => result.qualifySource('Idle'), /Ambiguous/);
  assert.throws(() => result.qualifySource('Move'), /Ambiguous/);
  assert.equal(result.group, null);
});

test('native group object IDs are validated and cannot be duplicated', () => {
  const valid = convertTemplate(oldTemplate).text;
  const root = parseDocument(valid)[0];
  const groups = child(root, 'Groups');
  const groupId = groups.children[0].head[1].value;
  assert.throws(() => convertTemplate(valid.replace(groupId, '{bad}')), /GUID/);
});

test('instance conversion preserves every exact binary animation resource reference', () => {
  const result = convertInstance(oldInstance, instanceOptions());
  assert.deepEqual(result.assignments, [
    { source: 'Default.Default.Idle', resource: '{0123456789ABCDEF}Example/idle.anm' },
    { source: 'Default.Default.Move', resource: 'Example/move.anm' },
  ]);
  const again = convertInstance(result.text, instanceOptions());
  assert.equal(again.text, result.text);
});

test('instance duplicate/orphan assignments and parent inheritance are rejected', () => {
  assert.throws(() => convertInstance(oldInstance.replace('"Move"', '"Idle"'), instanceOptions()), /Duplicate animation assignment/);
  assert.throws(() => convertInstance(oldInstance.replace('"Move"', '"Missing"'), instanceOptions()), /not declared/);
  assert.throws(() => convertInstance(oldInstance.replace('#nparents 0', '#nparents 1'), instanceOptions()), /inheritance/);
  const native = convertInstance(oldInstance, instanceOptions()).text;
  assert.throws(() => convertInstance(native.replace('ParentTemplates {', 'ParentTemplates { "Other/parent.asi"'), instanceOptions()), /inheritance/);
  assert.throws(() => convertInstance(native.replace('Resource "Example/move.anm"', 'Resource "Example/move.anm"\n Speed 2'), instanceOptions()), /Unsupported field/);
});

test('valid empty native instance stays valid without discarding hidden fields', () => {
  const empty = 'AnimSetInstanceSource {\n Template "Example/template.ast"\n}';
  assert.deepEqual(convertInstance(empty, instanceOptions()).assignments, []);
  assert.throws(() => convertInstance(empty.replace('\n}', '\n ExtraFlag 1\n}'), instanceOptions()), /Unsupported field/);
});

test('workspace template conflict is reported and all canonical resource refs are rewritten', () => {
  const result = convertWorkspace(oldWorkspace, workspaceOptions);
  const root = parseDocument(result.text)[0];
  assert.equal(root.head[1].value, workspaceOptions.workspaceRef);
  assert.equal(child(root, 'AnimSetTemplate').head[1].value, workspaceOptions.templateRef);
  assert.equal(child(root, 'AnimGraph').head[1].value, workspaceOptions.graphRef);
  assert.equal(result.warnings.length, 1);
  const preview = child(root, 'PreviewModels').children[0];
  assert.equal(child(preview, 'Model').head[1].value, 'Example/model.xob');
  assert.equal(root.children.at(-1).head[1].quoted, false);
});

test('workspace native round trip preserves preview identity and reference', () => {
  const first = convertWorkspace(oldWorkspace, workspaceOptions);
  const second = convertWorkspace(first.text, workspaceOptions);
  assert.equal(second.text, first.text);
  assert.equal(second.warnings.length, 0);
});

test('workspace preview may gain existing resource GUID but cannot change model path', () => {
  const converted = convertWorkspace(oldWorkspace, { ...workspaceOptions, modelRef: '{FEDCBA0987654321}Example/model.xob' });
  assert.match(converted.text, /\{FEDCBA0987654321\}Example\/model\.xob/);
  assert.throws(() => convertWorkspace(oldWorkspace, { ...workspaceOptions, modelRef: 'Other/model.xob' }), /retain the original model path/);
});

test('workspace unknown fields and unverified nonempty preview options are rejected', () => {
  assert.throws(() => convertWorkspace(oldWorkspace.replace('#animGraph', '#unknown'), workspaceOptions), /Unsupported field/);
  assert.throws(() => convertWorkspace(oldWorkspace.replace('#NanimSetInstances 1', '#NanimSetInstances 2'), workspaceOptions), /count does not match/);
  const native = convertWorkspace(oldWorkspace, workspaceOptions).text;
  assert.throws(() => convertWorkspace(native.replace('Model "Example/model.xob"', 'Model "Example/model.xob"\n Position 1 2 3'), workspaceOptions), /Unsupported field/);
  const withAttachments = native.replace(/(AttachmentTesting [^\n]+\{)/, '$1\n Attachments {}');
  assert.throws(() => convertWorkspace(withAttachments, workspaceOptions), /Nonempty AttachmentTesting/);
});

test('workspace event table reference is preserved', () => {
  const native = convertWorkspace(oldWorkspace, workspaceOptions).text;
  const withEventTable = native.replace(' PreviewModels {', ' EventTable "Example/events.ae"\n PreviewModels {');
  assert.match(convertWorkspace(withEventTable, workspaceOptions).text, /EventTable "Example\/events\.ae"/);
});

test('malformed references and decoded controls are rejected', () => {
  assert.throws(() => splitResourceRef('{broken}Example/idle.anm'), /Malformed resource GUID/);
  assert.throws(() => splitResourceRef('Example/\nidle.anm'), /control/);
  assert.throws(() => convertInstance(oldInstance.replace('Example/move.anm', 'Example/\\nmove.anm'), instanceOptions()), /control/);
});

test('deterministic GUIDs are namespace-sensitive and normalize resource path case/slashes', () => {
  const a = deterministicGuid('project-one', 'Example/graph.agr');
  assert.match(a, /^[A-F0-9]{16}$/);
  assert.equal(a, deterministicGuid('project-one', 'EXAMPLE\\GRAPH.AGR'));
  assert.notEqual(a, deterministicGuid('project-two', 'Example/graph.agr'));
  assert.equal(resourceRef('Example\\graph.agr', a), `{${a}}Example/graph.agr`);
});

test('all supported meta file classes use valid native inheritance headers', () => {
  for (const [extension, className] of Object.entries({ ast: 'AnimSetTemplateResourceClass', asi: 'AnimSetInstanceResourceClass', aw: 'AnimWorkspaceResourceClass', agr: 'AnimGraphResourceClass', agf: 'AnimGraphFileResourceClass' })) {
    const text = generateMeta(`Example/file.${extension}`, '1234567890ABCDEF');
    const root = parseDocument(text)[0];
    assert.equal(child(root, 'Name').head[1].value, `{1234567890ABCDEF}Example/file.${extension}`);
    const configs = child(root, 'Configurations').children;
    assert.deepEqual(values(configs[0]), [className, 'PC']);
    assert.deepEqual(values(configs[1]), [className, 'XBOX_ONE', ':', 'PC']);
    assert.equal(configs.length, 4);
  }
  assert.throws(() => generateMeta('Example/file.unknown', '1234567890ABCDEF'), /Unsupported metadata type/);
  for (const type of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => generateMeta('Example/file.ast', '1234567890ABCDEF', type), /Unsupported metadata type/);
  }
});
