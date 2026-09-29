import { createHash } from 'node:crypto';
import { parseDocument, values, quote, serialize } from './syntax.mjs';

/** Error raised before emitting output when a resource cannot be converted safely. */
export class ResourceConversionError extends Error {
  constructor(message, source = '<resource>', line) {
    super(`${source}${line ? `:${line}` : ''}: ${message}`);
    this.name = 'ResourceConversionError';
    this.code = 'UNSUPPORTED_RESOURCE';
  }
}

const token = (value, quoted = false) => ({ value: String(value), quoted });
const node = (name, args = [], items = null) => ({
  head: [token(name), ...args.map(value => token(value, true))], children: items,
});
const list = values => values.map(value => ({ head: [token(value, true)], children: null }));
const fail = (message, source, entry) => { throw new ResourceConversionError(message, source, entry?.line); };

function rootOf(text, allowed, source) {
  const document = parseDocument(text, { source });
  if (document.length !== 1 || !allowed.includes(document[0].head[0]?.value)) {
    fail(`Expected exactly one ${allowed.join(' or ')} root.`, source, document[0]);
  }
  const root = document[0];
  if (root.children === null) fail('Expected a resource block.', source, root);
  return root;
}

function schema(entry, allowed, source, repeat = []) {
  if (entry.children === null) fail('Expected a block.', source, entry);
  const map = new Map();
  for (const item of entry.children) {
    const key = item.head[0]?.value;
    if (!allowed.includes(key)) fail(`Unsupported field ${quote(key ?? '')}.`, source, item);
    if (map.has(key) && !repeat.includes(key)) fail(`Duplicate field ${quote(key)}.`, source, item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return {
    one: (key, required = false) => {
      const item = map.get(key)?.[0];
      if (!item && required) fail(`Missing field ${quote(key)}.`, source, entry);
      return item;
    },
    many: key => map.get(key) ?? [],
  };
}

function scalar(entry, source, required = true) {
  if (!entry) {
    if (required) fail('Missing scalar field.', source);
    return undefined;
  }
  if (entry.children !== null || entry.head.length !== 2) fail('Expected one scalar value.', source, entry);
  return entry.head[1].value;
}

function block(entry, source, headLength = 1) {
  if (!entry || entry.children === null || entry.head.length !== headLength) {
    fail('Unexpected block header or missing block.', source, entry);
  }
  return entry.children;
}

function count(entry, source) {
  const value = scalar(entry, source);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail(`Invalid count ${quote(value)}.`, source, entry);
  return Number(value);
}

function strings(entry, source) {
  const result = [];
  for (const item of block(entry, source)) {
    if (item.children !== null || item.head.some(t => !t.quoted)) {
      fail('Expected a list of quoted strings.', source, item);
    }
    result.push(...values(item));
  }
  return result;
}

function uniqueNames(names, kind, source, entry) {
  const used = new Set();
  for (const name of names) {
    if (!name || name.includes('.') || /[\x00-\x1f\x7f]/.test(name)) {
      fail(`${kind} name must be nonempty and contain neither a dot nor control characters: ${quote(name)}.`, source, entry);
    }
    if (used.has(name)) fail(`Duplicate ${kind} name ${quote(name)}.`, source, entry);
    used.add(name);
  }
}

function reference(value, source, entry) {
  try { splitResourceRef(value); } catch (error) { fail(error.message, source, entry); }
  return value;
}

function output(root) { return serialize([root]); }

/** Split a DayZ resource reference without changing its resource path. */
export function splitResourceRef(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError('Resource reference must be a nonempty string without control characters.');
  }
  const match = /^\{([0-9a-fA-F]{16})\}(.+)$/.exec(value);
  if (value.startsWith('{') && !match) throw new TypeError(`Malformed resource GUID in ${quote(value)}.`);
  return { guid: match ? match[1].toUpperCase() : null, path: match ? match[2] : value };
}

/** Resource IDs are stable for the same caller-provided namespace and path. */
export function deterministicGuid(namespace, resourcePath) {
  if (typeof namespace !== 'string' || !namespace) throw new TypeError('A nonempty GUID namespace is required.');
  const { path } = splitResourceRef(resourcePath);
  return createHash('sha256').update(namespace).update('\0').update(path.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 16).toUpperCase();
}

export function resourceRef(resourcePath, guid) {
  const { path } = splitResourceRef(resourcePath);
  if (typeof guid !== 'string' || !/^[0-9a-fA-F]{16}$/.test(guid)) throw new TypeError('Resource GUID must be exactly 16 hexadecimal digits.');
  return `{${guid.toUpperCase()}}${path.replaceAll('\\', '/')}`;
}

const metaClasses = {
  ast: 'AnimSetTemplateResourceClass',
  asi: 'AnimSetInstanceResourceClass',
  aw: 'AnimWorkspaceResourceClass',
  agr: 'AnimGraphResourceClass',
  agf: 'AnimGraphFileResourceClass',
};

export function generateMeta(resourcePath, guid, type) {
  const key = (type ?? splitResourceRef(resourcePath).path.split('.').pop()).replace(/^\./, '').toLowerCase();
  const className = Object.hasOwn(metaClasses, key) ? metaClasses[key] : undefined;
  if (!className) throw new TypeError(`Unsupported metadata type ${quote(key)}.`);
  const configurations = ['PC', 'XBOX_ONE', 'PS4', 'LINUX'].map(platform => ({
    head: [token(className), token(platform), ...(platform === 'PC' ? [] : [token(':'), token('PC')])],
    children: [],
  }));
  return output(node('MetaFileClass', [], [node('Name', [resourceRef(resourcePath, guid)]), node('Configurations', [], configurations)]));
}

/** Convert a legacy unnamed template, or validate a native template. */
export function convertTemplate(text, { source = '<template>', group = 'Default', column = 'Default', id } = {}) {
  const root = rootOf(text, ['$animsettemplate', 'AnimSetTemplateSource'], source);
  if (root.head.length !== 1) fail('Unexpected template root header.', source, root);
  const groups = [];
  let converted;
  const warnings = [];
  if (root.head[0].value === '$animsettemplate') {
    const fields = schema(root, ['#ngrouptypes', '$groupType'], source, ['$groupType']);
    const types = fields.many('$groupType');
    if (count(fields.one('#ngrouptypes', true), source) !== types.length) fail('Group type count does not match its blocks.', source, root);
    if (types.length !== 1) fail('Legacy templates with multiple group types are not supported.', source, root);
    block(types[0], source);
    const fieldsOfType = schema(types[0], ['#ngroupnames', '#nanims', '$anims'], source);
    if (count(fieldsOfType.one('#ngroupnames', true), source) !== 0) {
      fail('Named legacy groups require a verified schema and are not supported.', source, types[0]);
    }
    uniqueNames([group], 'group', source, types[0]);
    uniqueNames([column], 'column', source, types[0]);
    const animations = strings(fieldsOfType.one('$anims', true), source);
    if (count(fieldsOfType.one('#nanims', true), source) !== animations.length) fail('Animation count does not match its list.', source, types[0]);
    uniqueNames(animations, 'animation', source, types[0]);
    const groupId = id ?? deterministicGuid('AnimGraphMigration/group', `${source}/${group}`);
    if (!/^[0-9a-fA-F]{16}$/.test(groupId)) fail('Group ID must be 16 hexadecimal digits.', source, root);
    groups.push({ name: group, columns: [column], animations });
    converted = node('AnimSetTemplateSource', [], [node('Groups', [], [
      node('AnimSetTemplateSource_AnimationGroup', [`{${groupId.toUpperCase()}}`], [
        node('Name', [group]), node('Animations', [], list(animations)), node('Columns', [], list([column])),
      ]),
    ])]);
    warnings.push(`Unnamed legacy group assigned explicit group ${quote(group)} and column ${quote(column)}.`);
  } else {
    const fields = schema(root, ['Groups'], source);
    const groupBlock = fields.one('Groups', true);
    const ids = new Set();
    for (const item of block(groupBlock, source)) {
      if (item.head[0].value !== 'AnimSetTemplateSource_AnimationGroup') fail('Unsupported native group type.', source, item);
      block(item, source, 2);
      const objectId = item.head[1].value;
      if (!/^\{[0-9a-fA-F]{16}\}$/.test(objectId) || ids.has(objectId.toUpperCase())) fail('Invalid or duplicate group object GUID.', source, item);
      ids.add(objectId.toUpperCase());
      const groupFields = schema(item, ['Name', 'Animations', 'Columns'], source);
      const name = scalar(groupFields.one('Name', true), source);
      const animations = strings(groupFields.one('Animations', true), source);
      const columns = strings(groupFields.one('Columns', true), source);
      uniqueNames([name], 'group', source, item);
      uniqueNames(animations, 'animation', source, item);
      uniqueNames(columns, 'column', source, item);
      if (!columns.length) fail('Native groups require at least one explicit column.', source, item);
      groups.push({ name, columns, animations });
    }
    uniqueNames(groups.map(item => item.name), 'group', source, groupBlock);
    converted = root;
  }
  const slots = groups.flatMap(item => item.columns.flatMap(col => item.animations.map(animation => `${item.name}.${col}.${animation}`)));
  const slotSet = new Set(slots);
  const bareSlots = new Map();
  for (const slot of slots) {
    const name = slot.split('.')[2];
    bareSlots.set(name, [...(bareSlots.get(name) ?? []), slot]);
  }
  const qualifySource = value => {
    if (slotSet.has(value)) return value;
    const candidates = bareSlots.get(value) ?? [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) fail(`Ambiguous animation source ${quote(value)}; use group.column.animation.`, source);
    fail(`Animation source ${quote(value)} is not declared in the template.`, source);
  };
  return {
    text: output(converted), slots, groups, qualifySource, warnings,
    group: groups.length === 1 ? groups[0].name : null,
    column: groups.length === 1 && groups[0].columns.length === 1 ? groups[0].columns[0] : null,
  };
}

/** Preserve every animation resource assignment while qualifying its slot. */
export function convertInstance(text, { source = '<instance>', templateRef, qualifySource } = {}) {
  if (typeof qualifySource !== 'function') fail('A template-backed qualifySource callback is required.', source);
  reference(templateRef, source);
  const root = rootOf(text, ['$animsetinstance', 'AnimSetInstanceSource'], source);
  if (root.head.length !== 1) fail('Unexpected instance root header.', source, root);
  const assignments = [];
  const seen = new Set();
  const add = (name, resource, entry) => {
    const qualified = qualifySource(name);
    if (typeof qualified !== 'string' || !/^[^.]+\.[^.]+\.[^.]+$/.test(qualified)) fail('qualifySource returned an invalid qualified slot.', source, entry);
    if (seen.has(qualified)) fail(`Duplicate animation assignment ${quote(qualified)}.`, source, entry);
    reference(resource, source, entry);
    seen.add(qualified);
    assignments.push({ source: qualified, resource });
  };
  if (root.head[0].value === '$animsetinstance') {
    const fields = schema(root, ['#template', '#nparents', '$animations'], source);
    reference(scalar(fields.one('#template', true), source), source, root);
    if (count(fields.one('#nparents', true), source) !== 0) fail('Instance parent inheritance is not supported.', source, root);
    const animations = fields.one('$animations', true);
    for (const entry of block(animations, source)) {
      if (entry.children !== null || entry.head.length !== 2 || entry.head.some(t => !t.quoted)) fail('Expected a quoted animation name and resource pair.', source, entry);
      add(entry.head[0].value, entry.head[1].value, entry);
    }
  } else {
    const fields = schema(root, ['Template', 'ParentTemplates', 'Lines'], source);
    reference(scalar(fields.one('Template', true), source), source, root);
    const parents = fields.one('ParentTemplates');
    if (parents && strings(parents, source).length) fail('Instance parent inheritance is not supported.', source, parents);
    const lines = fields.one('Lines');
    for (const entry of lines ? block(lines, source) : []) {
      if (entry.head[0].value !== 'AnimSetInstanceSource_Line') fail('Unsupported native animation line type.', source, entry);
      block(entry, source, 2);
      const lineFields = schema(entry, ['Resource'], source);
      add(entry.head[1].value, scalar(lineFields.one('Resource', true), source), entry);
    }
  }
  const lineEntries = assignments.map(item => node('AnimSetInstanceSource_Line', [item.source], [node('Resource', [item.resource])]));
  return { text: output(node('AnimSetInstanceSource', [], [node('Template', [templateRef]), node('ParentTemplates', [], []), node('Lines', [], lineEntries)])), assignments, warnings: [] };
}

function validateObjectId(entry, source, index) {
  if (!/^\{[0-9a-fA-F]{16}\}$/.test(entry.head[index]?.value ?? '')) fail('Expected an object GUID.', source, entry);
}

/** Convert workspace references, preserving verified preview and auxiliary fields. */
export function convertWorkspace(text, { source = '<workspace>', templateRef, instanceRefs, graphRef, workspaceRef, modelRef } = {}) {
  reference(templateRef, source);
  reference(graphRef, source);
  if (!Array.isArray(instanceRefs)) fail('instanceRefs must be an array.', source);
  for (const ref of instanceRefs) reference(ref, source);
  if (new Set(instanceRefs).size !== instanceRefs.length) fail('Duplicate workspace instance references.', source);
  const root = rootOf(text, ['$animWorkspace', 'BaseSource'], source);
  const warnings = [];
  let previewModels;
  const extras = [];
  let currentTemplate;
  if (root.head[0].value === '$animWorkspace') {
    if (root.head.length !== 1) fail('Unexpected legacy workspace root header.', source, root);
    reference(workspaceRef, source);
    const fields = schema(root, ['#animSetTemplate', '#NanimSetInstances', '#animSetInstance', '#previewModel', '#animGraph'], source, ['#animSetInstance']);
    currentTemplate = reference(scalar(fields.one('#animSetTemplate', true), source), source, root);
    const oldInstances = fields.many('#animSetInstance');
    if (count(fields.one('#NanimSetInstances', true), source) !== oldInstances.length) fail('Workspace instance count does not match its references.', source, root);
    if (oldInstances.length !== instanceRefs.length) fail('Output instance references must preserve the workspace instance count.', source, root);
    for (const entry of oldInstances) reference(scalar(entry, source), source, entry);
    reference(scalar(fields.one('#animGraph', true), source), source, root);
    const model = fields.one('#previewModel');
    if (model) {
      const originalModel = reference(scalar(model, source), source, model);
      const targetModel = modelRef ?? originalModel;
      reference(targetModel, source, model);
      const modelPath = value => splitResourceRef(value).path.replaceAll('\\', '/').toLowerCase();
      if (modelPath(targetModel) !== modelPath(originalModel)) fail('Preview model override must retain the original model path.', source, model);
      const guid = deterministicGuid('AnimGraphMigration/preview', `${workspaceRef}/${originalModel}`);
      previewModels = node('PreviewModels', [], [node('AnimSrcWorkspacePreviewModel', [`{${guid}}`], [node('Model', [targetModel])])]);
    }
    extras.push(node('AttachmentTesting', ['AnimSrcWorkspaceAttachmentTesting', `{${deterministicGuid('AnimGraphMigration/attachment', workspaceRef)}}`], []));
    extras.push(node('IkTesting', ['AnimSrcWorkspaceIkTesting', `{${deterministicGuid('AnimGraphMigration/ik', workspaceRef)}}`], []));
    // Class names in these inline object headers are identifiers, not quoted strings.
    for (const extra of extras) extra.head[1].quoted = false;
  } else {
    if (root.head.length !== 2) fail('Expected native workspace self reference.', source, root);
    reference(root.head[1].value, source, root);
    workspaceRef = workspaceRef ?? root.head[1].value;
    reference(workspaceRef, source);
    const fields = schema(root, ['AnimSetTemplate', 'AnimSetInstances', 'AnimGraph', 'PreviewModels', 'EventTable', 'AttachmentTesting', 'IkTesting'], source);
    currentTemplate = reference(scalar(fields.one('AnimSetTemplate', true), source), source, root);
    const oldInstances = strings(fields.one('AnimSetInstances', true), source);
    for (const ref of oldInstances) reference(ref, source, root);
    if (oldInstances.length !== instanceRefs.length) fail('Output instance references must preserve the workspace instance count.', source, root);
    reference(scalar(fields.one('AnimGraph', true), source), source, root);
    previewModels = fields.one('PreviewModels');
    const ids = new Set();
    for (const entry of previewModels ? block(previewModels, source) : []) {
      if (entry.head[0].value !== 'AnimSrcWorkspacePreviewModel') fail('Unsupported preview model type.', source, entry);
      block(entry, source, 2);
      validateObjectId(entry, source, 1);
      if (ids.has(entry.head[1].value.toUpperCase())) fail('Duplicate preview model object GUID.', source, entry);
      ids.add(entry.head[1].value.toUpperCase());
      const modelFields = schema(entry, ['Model'], source);
      reference(scalar(modelFields.one('Model', true), source), source, entry);
    }
    const eventTable = fields.one('EventTable');
    if (eventTable) { reference(scalar(eventTable, source), source, eventTable); extras.push(eventTable); }
    for (const [name, className] of [['AttachmentTesting', 'AnimSrcWorkspaceAttachmentTesting'], ['IkTesting', 'AnimSrcWorkspaceIkTesting']]) {
      const entry = fields.one(name);
      if (!entry) continue;
      block(entry, source, 3);
      if (entry.head[1].value !== className) fail(`Unsupported ${name} type.`, source, entry);
      validateObjectId(entry, source, 2);
      if (entry.children.length) fail(`Nonempty ${name} settings are not supported; preserving their semantics requires additional schema evidence.`, source, entry);
      extras.push(entry);
    }
  }
  if (splitResourceRef(currentTemplate).path.toLowerCase() !== splitResourceRef(templateRef).path.toLowerCase()) {
    warnings.push(`Workspace template reference replaced: ${currentTemplate} -> ${templateRef}. The graph-selected template is authoritative.`);
  }
  const result = node('BaseSource', [workspaceRef], [node('AnimSetTemplate', [templateRef]), node('AnimSetInstances', [], list(instanceRefs)), node('AnimGraph', [graphRef]), ...(previewModels ? [previewModels] : []), ...extras]);
  return { text: output(result), warnings };
}
