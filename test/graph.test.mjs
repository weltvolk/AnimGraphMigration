import test from 'node:test';
import assert from 'node:assert/strict';
import { convertGraphFile, convertGraphRoot, inspectGraphFile } from '../src/graph.mjs';
import { parseDocument, child, children, values } from '../src/syntax.mjs';

// Entirely synthetic. No game files or mod assets are included in this fixture.
const graph = `$AnimGraph 7 {
 $Sheet "Example" {
  $Node AnimNodeStateMachine {
   "Machine" ""
   $States 2 {
    $State {
     "Idle" "" "Clip" "speed < 1 && Check(2)" "realtime" 0
     $EditorData { #EditorPos 3 -4 }
    }
    $State {
     "Move" "" "Choice" "speed >= 1" "notime" 1
    }
   }
   $Transitions 2 {
    $Transition {
     "Idle" "Move" "speed >= 1" "0.2 + GetVar()" "0.0" 1 "S"
    }
    $Transition {
     "" "Idle" "IsCommand(RESET)" "" "" 0 "S"
    }
   }
   $EditorData { #EditorPos -1 2 }
  }
  $Node AnimNodeSource {
   "Clip" "ExampleTag" "IdleClip" "noloop"
   $Predictions {}
   $EditorData { #EditorPos 1 -2 }
  }
  $Node AnimNodeSwitch {
   "Choice" "" 0 0.0
   $switchitems 2 {
    $si { "Clip" "true" "25%=1,75%=0" }
    $si { "Clip" "" "50%=0,50%=1" }
   }
   $EditorData { #EditorPos 0 0 }
  }
 }
}
`;
const wrapper = `$AnimGraph 7 {
 #AnimSetTemplate "Example/template.ast"
 $Controls {
  $Commands {
   RESET -1
  }
  $Vars {
   #Var speed float 0.0 0.0 5.0 ""
   #Var counter int 1 0 3 ""
  }
  $Expressions {}
  $DebugControls {
   #DCtrl 2 "" "Reset" "" "RESET" 0.0 0
  }
 }
 $Files {
  "Example/main.agr"
 }
}
`;
const nativeNodes = text => child(child(child(parseDocument(text)[0], 'Sheets'), 'AnimSrcGraphSheet'), 'Nodes').children;

test('converts all three verified node types and preserves expressions/global transitions', () => {
  const result = convertGraphFile(graph, { source: 'example.agr', qualifySource: name => 'Default.Default.' + name });
  assert.deepEqual(result.stats, { sheets: 1, nodes: 3, statemachines: 1, states: 2, transitions: 2, sources: 1, switches: 1, switchItems: 2 });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'EDITOR_POSITION_ADDED');
  const [machine, clip, choice] = nativeNodes(result.text);
  assert.deepEqual(values(child(machine, 'EditorPos')), ['EditorPos', '-1', '-2']);
  const states = child(machine, 'states').children;
  assert.equal(values(child(states[0], 'TimeStorage'))[1], 'Real Time');
  assert.equal(values(child(states[1], 'TimeStorage'))[1], 'Inherit');
  assert.equal(values(child(states[1], 'IsExit'))[1], '1');
  assert.equal(values(child(states[0], 'StartCondition'))[1], 'speed < 1 && Check(2)');
  const transitions = child(machine, 'transitions').children;
  assert.equal(values(child(transitions[0], 'Duration'))[1], '0.2 + GetVar()');
  assert.equal(child(transitions[1], 'FromState'), undefined);
  assert.equal(child(transitions[1], 'PostEval'), undefined);
  assert.deepEqual(values(child(transitions[1], 'MotionVecBlend')), ['MotionVecBlend', '0x33', '0']);
  assert.equal(values(child(clip, 'Source'))[1], 'Default.Default.IdleClip');
  assert.equal(values(child(clip, 'Looptype'))[1], 'No Loop');
  assert.equal(values(child(clip, 'Tags').children[0])[0], 'ExampleTag');
  const items = child(choice, 'SwitchItems').children;
  assert.equal(values(child(items[0], 'NextProbabilities'))[1], '75, 25');
  assert.equal(result.text, convertGraphFile(graph, { source: 'example.agr', qualifySource: name => 'Default.Default.' + name }).text);
});

test('converts root controls, resource references, debug command and numeric values', () => {
  const result = convertGraphRoot(wrapper, { templateRef: '{ABC}New/template.ast', graphRefs: ['{DEF}New/main.agf'] });
  assert.deepEqual(result.references, { template: 'Example/template.ast', graphs: ['Example/main.agr'] });
  const root = parseDocument(result.text)[0];
  assert.equal(values(child(root, 'AnimSetTemplate'))[1], '{ABC}New/template.ast');
  assert.equal(values(child(root, 'GraphFilesResourceNames').children[0])[0], '{DEF}New/main.agf');
  const controls = child(root, 'ControlTemplate');
  assert.equal(child(controls, 'Variables').children.length, 2);
  assert.equal(values(child(child(controls, 'Commands').children[0], 'Synchronized'))[1], '1');
  assert.deepEqual(result.stats, { variables: 2, commands: 1, debugControls: 1, graphFiles: 1 });
});

test('strict rejection prevents partial or silently damaged graph conversions', () => {
  for (const [before, after, expected] of [
    ['AnimNodeSwitch', 'AnimNodeBufferUse', /Unsupported node type/u],
    ['$States 2', '$States 3', /declares 3 elements but contains 2/u],
    ['"Move" "" "Choice"', '"Idle" "" "Choice"', /duplicate state/u],
    ['"Choice" "" 0 0.0', '"Clip" "" 0 0.0', /duplicate node/u],
    ['"Move" "" "Choice"', '"Move" "" "Missing"', /Dangling node/u],
    ['"Idle" "Move"', '"Idle" "Missing"', /Dangling transition/u],
    ['"notime"', '"unverified"', /Unsupported state time/u],
    ['"noloop"', '"constructor"', /Unsupported loop mode/u],
    ['"Machine" ""', '"Machine" "UnverifiedTag"', /Nonempty tags/u],
    ['"Idle" "" "Clip"', '"Idle" "UnverifiedTag" "Clip"', /Nonempty state tags/u],
    ['$Predictions {}', '$Predictions { "some" "data" }', /Nonempty \$Predictions/u],
    ['#EditorPos 1 -2', '#EditorPos 1 -2\n #Unknown 1', /Unsupported field/u],
    ['"Choice" "" 0 0.0', '"Choice" "" 1 0.0', /switch header/u],
    ['"25%=1,75%=0"', '"25%=1,75%=1"', /duplicate probability/u],
    ['"25%=1,75%=0"', '"25%=1,70%=0"', /sum to 100/u],
    ['1 "S"', '1 "Unknown"', /Unsupported blend/u],
  ]) assert.throws(() => convertGraphFile(graph.replace(before, after), { source: 'bad.agr' }), expected, after);
});

test('root rejects unverified controls and malformed references', () => {
  for (const [before, after, expected] of [
    ['RESET -1', 'RESET 0', /Unsupported command flag/u],
    ['speed float', 'speed bool', /Unsupported variable type/u],
    ['5.0 ""', '5.0 "description"', /annotation/u],
    ['$Expressions {}', '$Expressions { foo "bar" }', /Custom control expressions/u],
    ['#DCtrl 2', '#DCtrl 3', /command debug controls/u],
    ['"RESET" 0.0', '"MISSING" 0.0', /Dangling debug/u],
  ]) assert.throws(() => convertGraphRoot(wrapper.replace(before, after)), expected);
  assert.throws(() => convertGraphRoot(wrapper, { graphRefs: [] }), /reference count/u);
});

test('preflight identities support cross-file references without suppressing duplicate checks', () => {
  assert.deepEqual(inspectGraphFile(graph).nodeNames, ['Machine', 'Clip', 'Choice']);
  const externalGraph = graph.replace('"Move" "" "Choice"', '"Move" "" "ExternalClip"');
  assert.throws(() => convertGraphFile(externalGraph), /Dangling node/u);
  assert.equal(convertGraphFile(externalGraph, { externalNodeNames: ['ExternalClip'] }).stats.states, 2);
  assert.throws(() => convertGraphFile(graph, { externalNodeNames: ['Clip'] }), /duplicate node/u);
});

test('more than six significant fractional digits in switch weights are not rounded away', () => {
  const result = convertGraphFile(graph.replace('25%=1,75%=0', '25.1234567%=1,74.8765433%=0'));
  assert.match(result.text, /74\.8765433, 25\.1234567/u);
});

test('quoted names and escaped condition strings survive conversion', () => {
  const modified = graph.replaceAll('"Clip"', '"Clip with space"').replace('"speed < 1 && Check(2)"', '"Call(\\"x\\") && speed < 1"');
  const result = convertGraphFile(modified);
  assert.match(result.text, /AnimSrcNodeSource "Clip with space"/u);
  const state = child(nativeNodes(result.text)[0], 'states').children[0];
  assert.equal(values(child(state, 'StartCondition'))[1], 'Call("x") && speed < 1');
});
