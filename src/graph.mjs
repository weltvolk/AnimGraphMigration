import { createHash } from 'node:crypto';
import { parseDocument, values, child, children, quote } from './syntax.mjs';

const id = value => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ? value : quote(value);
const numeric = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u;
const guid = value => '{' + createHash('sha256').update(value).digest('hex').slice(0, 16).toUpperCase() + '}';
const lookup = (mapping, value) => Object.hasOwn(mapping, value) ? mapping[value] : undefined;

function context(source = '<input>') {
  const fail = (entry, message) => { throw new Error(`${source}:${entry?.line ?? 1}:${entry?.head?.[0]?.column ?? 1}: ${message}`); };
  const arity = (entry, count) => {
    if (!entry || entry.head.length !== count) fail(entry, `Expected ${count} fields, got ${entry?.head.length ?? 0}`);
    return values(entry);
  };
  const block = (entry, count = 1) => {
    arity(entry, count);
    if (entry.children === null) fail(entry, 'Expected a block');
    return entry.children;
  };
  const leaf = (entry, count) => {
    arity(entry, count);
    if (entry.children !== null) fail(entry, 'Unexpected nested block');
    return values(entry);
  };
  const one = (entry, name, required = true) => {
    const matches = children(entry, name);
    if (matches.length > 1) fail(matches[1], `Duplicate ${name}`);
    if (!matches.length && required) fail(entry, `Missing ${name}`);
    return matches[0];
  };
  const number = (entry, value, label) => {
    if (!numeric.test(value) || !Number.isFinite(Number(value))) fail(entry, `Invalid ${label}: ${value}`);
    return Number(value);
  };
  const integer = (entry, value, label) => {
    const result = number(entry, value, label);
    if (!Number.isSafeInteger(result)) fail(entry, `Invalid integer ${label}: ${value}`);
    return result;
  };
  const flag = (entry, value, label) => {
    if (value !== '0' && value !== '1') fail(entry, `Unsupported ${label} ${value}; only 0 and 1 are verified`);
    return value;
  };
  const known = (entry, allowed) => {
    for (const item of entry.children ?? []) if (!allowed.includes(item.head[0]?.value)) fail(item, `Unsupported field ${item.head[0]?.value}`);
  };
  const root = text => {
    const entries = parseDocument(text, { source });
    if (entries.length !== 1 || entries[0].head[0]?.value !== '$AnimGraph') fail(entries[0], 'Expected one legacy $AnimGraph 7 block');
    block(entries[0], 2);
    if (values(entries[0])[1] !== '7') fail(entries[0], 'Only legacy $AnimGraph version 7 is supported');
    return entries[0];
  };
  return { source, fail, arity, block, leaf, one, number, integer, flag, known, root };
}

class Writer {
  lines = [];
  depth = 0;
  line(value) { this.lines.push(' '.repeat(this.depth) + value); }
  block(header, callback) { this.line(header + ' {'); this.depth++; callback(); this.depth--; this.line('}'); }
  toString() { return this.lines.join('\n') + '\n'; }
}

function counted(ctx, parent, name, itemName) {
  const entry = ctx.one(parent, name);
  ctx.block(entry, 2);
  const count = ctx.integer(entry, values(entry)[1], `${name} count`);
  if (count < 0) ctx.fail(entry, 'Negative element count');
  ctx.known(entry, [itemName]);
  const items = children(entry, itemName);
  if (items.length !== count) ctx.fail(entry, `${name} declares ${count} elements but contains ${items.length}`);
  return items;
}

function payload(ctx, entry, allowed, fieldCount) {
  const plain = (entry.children ?? []).filter(item => item.children === null && item.head[0]?.quoted);
  if (plain.length !== 1) ctx.fail(entry, `Expected exactly one quoted payload line, found ${plain.length}`);
  for (const item of entry.children ?? []) if (item !== plain[0] && !allowed.includes(item.head[0]?.value)) ctx.fail(item, `Unsupported field ${item.head[0]?.value}`);
  return { entry: plain[0], values: ctx.leaf(plain[0], fieldCount) };
}

function editorPosition(ctx, entry, warnings, name) {
  const data = ctx.one(entry, '$EditorData', false);
  if (!data) {
    warnings.push({ code: 'EDITOR_POSITION_ADDED', message: `Added EditorPos 0 0 for ${name}`, line: entry.line });
    return '0 0';
  }
  ctx.block(data);
  ctx.known(data, ['#EditorPos']);
  const position = ctx.one(data, '#EditorPos');
  const [, x, y] = ctx.leaf(position, 3);
  return `${ctx.number(position, x, 'editor X')} ${-ctx.number(position, y, 'editor Y')}`;
}

function tags(writer, value) {
  if (value) writer.block('Tags', () => writer.line(quote(value)));
}

function probabilities(ctx, entry, value, count) {
  if (value === '') return '';
  const result = new Array(count);
  const pieces = value.split(',');
  if (pieces.length !== count) ctx.fail(entry, `Probability distribution must explicitly contain all ${count} switch indices`);
  for (const piece of pieces) {
    const match = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*%\s*=\s*(\d+)\s*$/u.exec(piece);
    if (!match) ctx.fail(entry, `Unsupported probability assignment: ${piece}`);
    const percent = ctx.number(entry, match[1], 'probability');
    const index = ctx.integer(entry, match[2], 'probability index');
    if (index >= count || result[index] !== undefined || percent < 0 || percent > 100) ctx.fail(entry, `Invalid or duplicate probability index/value: ${piece}`);
    result[index] = percent;
  }
  if (result.some(value => value === undefined)) ctx.fail(entry, 'Missing probability index');
  if (Math.abs(result.reduce((a, b) => a + b, 0) - 100) > 0.0001) ctx.fail(entry, 'Probability distribution must sum to 100');
  return result.map(String).join(', ');
}

/** Read node identities before converting a set of mutually referencing graph files. */
export function inspectGraphFile(text, { source = '<input>' } = {}) {
  const ctx = context(source);
  const root = ctx.root(text);
  ctx.known(root, ['$Sheet']);
  const nodeNames = [];
  const sourceNames = [];
  for (const sheet of children(root, '$Sheet')) {
    ctx.block(sheet, 2);
    ctx.known(sheet, ['$Node']);
    for (const node of children(sheet, '$Node')) {
      ctx.block(node, 2);
      const type = values(node)[1];
      const count = lookup({ AnimNodeStateMachine: 2, AnimNodeSource: 4, AnimNodeSwitch: 4 }, type);
      if (!count) ctx.fail(node, `Unsupported node type ${type}`);
      const allowed = { AnimNodeStateMachine: ['$States', '$Transitions', '$EditorData'], AnimNodeSource: ['$Predictions', '$EditorData'], AnimNodeSwitch: ['$switchitems', '$EditorData'] }[type];
      const data = payload(ctx, node, allowed, count);
      if (!data.values[0] || nodeNames.includes(data.values[0])) ctx.fail(data.entry, `Empty or duplicate node name: ${data.values[0]}`);
      nodeNames.push(data.values[0]);
      if (type === 'AnimNodeSource') sourceNames.push(data.values[2]);
    }
  }
  return { nodeNames, sourceNames: [...new Set(sourceNames)] };
}

/** Convert all sheets in a legacy graph file. No source files are changed. */
export function convertGraphFile(text, { source = '<input>', qualifySource = name => name, externalNodeNames = [] } = {}) {
  const ctx = context(source);
  const root = ctx.root(text);
  ctx.known(root, ['$Sheet']);
  const sheets = children(root, '$Sheet');
  if (!sheets.length) ctx.fail(root, 'A graph file must contain at least one $Sheet');
  const stats = { sheets: sheets.length, nodes: 0, statemachines: 0, states: 0, transitions: 0, sources: 0, switches: 0, switchItems: 0 };
  const warnings = [];
  const nodeNames = new Set(externalNodeNames);
  const sheetNames = new Set();
  const nodes = new Map();
  const sourceNames = new Set();
  for (const sheet of sheets) {
    ctx.block(sheet, 2);
    const name = values(sheet)[1];
    if (!name || sheetNames.has(name)) ctx.fail(sheet, `Empty or duplicate sheet name: ${name}`);
    sheetNames.add(name);
    ctx.known(sheet, ['$Node']);
    for (const node of children(sheet, '$Node')) {
      ctx.block(node, 2);
      const type = values(node)[1];
      const count = lookup({ AnimNodeStateMachine: 2, AnimNodeSource: 4, AnimNodeSwitch: 4 }, type);
      if (!count) ctx.fail(node, `Unsupported node type ${type}`);
      const allowed = { AnimNodeStateMachine: ['$States', '$Transitions', '$EditorData'], AnimNodeSource: ['$Predictions', '$EditorData'], AnimNodeSwitch: ['$switchitems', '$EditorData'] }[type];
      const data = payload(ctx, node, allowed, count);
      const name = data.values[0];
      if (!name || nodeNames.has(name)) ctx.fail(data.entry, `Empty or duplicate node name: ${name}`);
      if (type !== 'AnimNodeSource' && data.values[1] !== '') ctx.fail(data.entry, 'Nonempty tags on state machines or switches require a verified native sample');
      nodeNames.add(name);
      nodes.set(node, { type, name, ...data });
    }
  }
  const requireNode = (entry, name) => {
    if (!nodeNames.has(name)) ctx.fail(entry, `Dangling node reference: ${name}`);
  };
  const out = new Writer();
  out.block('AnimSrcGraphFile', () => out.block('Sheets', () => {
    for (const sheet of sheets) out.block(`AnimSrcGraphSheet ${id(values(sheet)[1])}`, () => out.block('Nodes', () => {
      for (const node of children(sheet, '$Node')) {
        const data = nodes.get(node);
        const [name, tag] = data.values;
        stats.nodes++;
        out.block(`${data.type.replace('AnimNode', 'AnimSrcNode')} ${id(name)}`, () => {
          tags(out, tag);
          out.line(`EditorPos ${editorPosition(ctx, node, warnings, name)}`);
          if (data.type === 'AnimNodeSource') {
            stats.sources++;
            const predictions = ctx.one(node, '$Predictions', false);
            if (predictions) {
              ctx.block(predictions);
              if (predictions.children.length) ctx.fail(predictions, 'Nonempty $Predictions are not supported');
            }
            const mode = lookup({ loop: 'Loop', noloop: 'No Loop' }, data.values[3]);
            if (!mode) ctx.fail(data.entry, `Unsupported loop mode ${data.values[3]}`);
            const animation = data.values[2];
            if (!animation) ctx.fail(data.entry, 'Empty animation source');
            const qualified = qualifySource(animation);
            if (typeof qualified !== 'string' || !qualified) ctx.fail(data.entry, `Cannot qualify animation source ${animation}`);
            sourceNames.add(animation);
            out.line(`Source ${quote(qualified)}`);
            out.line(`Looptype ${id(mode)}`);
          } else if (data.type === 'AnimNodeStateMachine') {
            stats.statemachines++;
            const states = counted(ctx, node, '$States', '$State');
            const transitions = counted(ctx, node, '$Transitions', '$Transition');
            const stateNames = new Set();
            stats.states += states.length;
            stats.transitions += transitions.length;
            out.block('states', () => {
              for (const state of states) {
                ctx.block(state);
                const stateData = payload(ctx, state, ['$EditorData'], 6);
                const [stateName, stateTag, target, condition, time, exit] = stateData.values;
                if (!stateName || stateNames.has(stateName)) ctx.fail(stateData.entry, `Empty or duplicate state name: ${stateName}`);
                if (stateTag !== '') ctx.fail(stateData.entry, 'Nonempty state tags require a verified native sample');
                stateNames.add(stateName);
                requireNode(stateData.entry, target);
                const timeStorage = lookup({ realtime: 'Real Time', notime: 'Inherit' }, time);
                if (!timeStorage) ctx.fail(stateData.entry, `Unsupported state time mode ${time}`);
                ctx.flag(stateData.entry, exit, 'state exit flag');
                out.block(`AnimSrcNodeState ${id(stateName)}`, () => {
                  tags(out, stateTag);
                  out.line(`EditorPos ${editorPosition(ctx, state, warnings, `${name}/${stateName}`)}`);
                  out.line(`Child ${quote(target)}`);
                  out.line(`StartCondition ${quote(condition)}`);
                  out.line(`TimeStorage ${quote(timeStorage)}`);
                  out.line(`IsExit ${exit}`);
                });
              }
            });
            out.block('transitions', () => {
              for (const [index, transition] of transitions.entries()) {
                ctx.block(transition);
                const record = payload(ctx, transition, [], 7);
                const [from, to, condition, duration, start, post, blend] = record.values;
                if ((from !== '' && !stateNames.has(from)) || !stateNames.has(to)) ctx.fail(record.entry, `Dangling transition state reference: ${from} -> ${to}`);
                ctx.flag(record.entry, post, 'transition PostEval');
                if (blend !== 'S') ctx.fail(record.entry, `Unsupported blend function ${blend}; only S is verified`);
                out.block(`AnimSrcNodeTransition ${quote(guid(`${source}\0${values(sheet)[1]}\0${name}\0transition\0${index}`))}`, () => {
                  if (from !== '') out.line(`FromState ${quote(from)}`);
                  out.line(`ToState ${quote(to)}`);
                  out.line(`Duration ${quote(duration)}`);
                  out.line(`StartTime ${quote(start)}`);
                  out.line(`Condition ${quote(condition)}`);
                  out.line('BlendFn S');
                  if (post === '1') out.line('PostEval 1');
                  out.line('MotionVecBlend 0x33 0');
                });
              }
            });
          } else {
            stats.switches++;
            if (data.values[2] !== '0' || ctx.number(data.entry, data.values[3], 'switch fourth field') !== 0) ctx.fail(data.entry, 'Only the verified switch header fields 0 0.0 are supported');
            const items = counted(ctx, node, '$switchitems', '$si');
            stats.switchItems += items.length;
            if (!items.length) ctx.fail(node, 'A switch must have at least one item');
            out.line('FirstProbabilities ""');
            out.block('SwitchItems', () => {
              for (const [index, item] of items.entries()) {
                ctx.block(item);
                const record = payload(ctx, item, [], 3);
                const [target, condition, distribution] = record.values;
                requireNode(record.entry, target);
                out.block(`AnimSrcNodeSwitchItem ${quote(guid(`${source}\0${values(sheet)[1]}\0${name}\0switch\0${index}`))}`, () => {
                  out.line(`Child ${quote(target)}`);
                  out.line(`NextProbabilities ${quote(probabilities(ctx, record.entry, distribution, items.length))}`);
                  out.line(`StartCond ${quote(condition)}`);
                });
              }
            });
          }
        });
      }
    }));
  }));
  return { text: out.toString(), stats, warnings, nodeNames: [...nodes.values()].map(item => item.name), sourceNames: [...sourceNames] };
}

/** Convert the legacy AGR wrapper and the verified controls/debug fields. */
export function convertGraphRoot(text, { source = '<input>', templateRef, graphRefs } = {}) {
  const ctx = context(source);
  const root = ctx.root(text);
  ctx.known(root, ['#AnimSetTemplate', '$Controls', '$Files']);
  const originalTemplate = ctx.leaf(ctx.one(root, '#AnimSetTemplate'), 2)[1];
  const files = ctx.one(root, '$Files');
  ctx.block(files);
  const originalGraphs = files.children.map(file => ctx.leaf(file, 1)[0]);
  if (!originalGraphs.length) ctx.fail(files, 'Graph wrapper contains no graph files');
  if (new Set(originalGraphs.map(value => value.toLowerCase())).size !== originalGraphs.length) ctx.fail(files, 'Duplicate graph file reference');
  const resolvedGraphs = graphRefs ?? originalGraphs.map(value => value.replace(/\.agr$/iu, '.agf'));
  if (resolvedGraphs.length !== originalGraphs.length || resolvedGraphs.some(value => typeof value !== 'string' || !value)) ctx.fail(files, 'Resolved graph reference count/value mismatch');
  if (templateRef !== undefined && (typeof templateRef !== 'string' || !templateRef)) ctx.fail(root, 'Empty resolved template reference');
  const controls = ctx.one(root, '$Controls');
  ctx.block(controls);
  ctx.known(controls, ['$Commands', '$Vars', '$Expressions', '$DebugControls']);
  const expressions = ctx.one(controls, '$Expressions', false);
  if (expressions) { ctx.block(expressions); if (expressions.children.length) ctx.fail(expressions, 'Custom control expressions are not supported'); }
  const commands = ctx.one(controls, '$Commands', false);
  const vars = ctx.one(controls, '$Vars', false);
  const debug = ctx.one(controls, '$DebugControls', false);
  if (commands) ctx.block(commands);
  if (vars) { ctx.block(vars); ctx.known(vars, ['#Var']); }
  if (debug) { ctx.block(debug); ctx.known(debug, ['#DCtrl']); }
  const commandEntries = commands?.children ?? [];
  const variableEntries = vars?.children ?? [];
  const debugEntries = debug?.children ?? [];
  const variableNames = new Set();
  const commandNames = new Set();
  const debugNames = new Set();
  const out = new Writer();
  const objectId = quote(guid(source + '\0controls'));
  out.block('AnimSrcGraph', () => {
    out.line(`AnimSetTemplate ${quote(templateRef ?? originalTemplate)}`);
    out.block(`ControlTemplate AnimSrcGCT ${objectId}`, () => {
      out.block('Variables', () => {
        for (const variable of variableEntries) {
          const [, name, type, initial, min, max, annotation] = ctx.leaf(variable, 7);
          if (!name || variableNames.has(name)) ctx.fail(variable, `Empty or duplicate control variable: ${name}`);
          variableNames.add(name);
          const nativeType = lookup({ float: 'Float', int: 'Int' }, type);
          if (!nativeType) ctx.fail(variable, `Unsupported variable type ${type}`);
          if (annotation !== '') ctx.fail(variable, 'Nonempty legacy variable annotation is not supported');
          const parse = type === 'int' ? ctx.integer : ctx.number;
          const numbers = [initial, min, max].map((value, index) => parse(variable, value, ['default', 'minimum', 'maximum'][index]));
          if (numbers[1] > numbers[2] || numbers[0] < numbers[1] || numbers[0] > numbers[2]) ctx.fail(variable, `Invalid variable range for ${name}`);
          out.block(`AnimSrcGCTVar${nativeType} ${id(name)}`, () => {
            out.line(`DefaultValue ${numbers[0]}`);
            out.line(`MinValue ${numbers[1]}`);
            out.line(`MaxValue ${numbers[2]}`);
          });
        }
      });
      out.block('Commands', () => {
        for (const command of commandEntries) {
          const [name, flag] = ctx.leaf(command, 2);
          if (!name || commandNames.has(name)) ctx.fail(command, `Empty or duplicate command: ${name}`);
          commandNames.add(name);
          if (flag !== '-1') ctx.fail(command, `Unsupported command flag ${flag}; only -1 -> Synchronized 1 is verified`);
          out.block(`AnimSrcGCTCmd ${id(name)}`, () => out.line('Synchronized 1'));
        }
      });
    });
    out.block(`Debug AnimSrcGD ${objectId}`, () => out.block('DebugControlGroups', () => {
      if (debugEntries.length) out.block('AnimSrcDebugCtlGroup __unnamed__', () => out.block('DebugControls', () => {
        for (const control of debugEntries) {
          const [, type, group, name, extra, binding, floatValue, intValue] = ctx.leaf(control, 8);
          if (type !== '2' || group !== '' || extra !== '') ctx.fail(control, 'Only command debug controls (#DCtrl 2, unnamed group, empty extra field) are verified');
          if (!name || debugNames.has(name)) ctx.fail(control, `Empty or duplicate debug control: ${name}`);
          debugNames.add(name);
          if (!commandNames.has(binding)) ctx.fail(control, `Dangling debug command binding: ${binding}`);
          out.block(`AnimSrcDebugCtlCmd ${id(name)}`, () => {
            out.line(`Binding ${quote(binding)}`);
            out.line(`FloatVal ${ctx.number(control, floatValue, 'debug float')}`);
            out.line(`IntVal ${ctx.integer(control, intValue, 'debug int')}`);
          });
        }
      }));
    }));
    out.block('GraphFilesResourceNames', () => resolvedGraphs.forEach(ref => out.line(quote(ref))));
  });
  return { text: out.toString(), stats: { variables: variableEntries.length, commands: commandEntries.length, debugControls: debugEntries.length, graphFiles: resolvedGraphs.length }, warnings: [], references: { template: originalTemplate, graphs: originalGraphs } };
}
