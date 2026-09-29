import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, values } from './syntax.mjs';
import { convertGraphFile, convertGraphRoot, inspectGraphFile } from './graph.mjs';
import { convertTemplate, convertInstance, convertWorkspace, generateMeta, deterministicGuid } from './resources.mjs';
import { validateAssetProfile } from './asset-profiles.mjs';
import { migrateRootMotionTxa } from './txa-rootmotion.mjs';

export const VERSION = '1.0.0';
export const REPORT_DIRECTORY = '.animgraph-migration';

export function virtualPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Empty or invalid resource path');
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error(`Unsafe resource path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function parseReference(value) {
  const match = /^\{([a-f0-9]{16})\}(.+)$/iu.exec(value);
  if (value.startsWith('{') && !match) throw new Error(`Invalid resource GUID reference: ${value}`);
  return { guid: match?.[1].toUpperCase() ?? null, path: virtualPath(match ? match[2] : value) };
}

const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();
const refString = (resource, guid) => `{${guid}}${resource}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const get = (entry, name) => (entry.children ?? []).filter(item => values(item)[0] === name);
function oneValue(entry, name, required = true) {
  const found = get(entry, name);
  if ((!required && !found.length)) return null;
  if (found.length !== 1 || found[0].children !== null || values(found[0]).length !== 2) throw new Error(`Expected exactly one ${name} resource reference`);
  return values(found[0])[1];
}

async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function assertNoLinks(file) {
  let current = path.resolve(file);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links/junctions are not accepted: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root) {
  await assertNoLinks(root);
  const real = await fs.realpath(root);
  if (!(await fs.stat(real)).isDirectory()) throw new Error('Input root must be a directory');
  const files = new Map();
  const names = new Map();
  const walk = async relative => {
    for (const item of await fs.readdir(path.join(real, relative), { withFileTypes: true })) {
      const resource = virtualPath(relative ? `${relative}/${item.name}` : item.name);
      if (item.isSymbolicLink()) throw new Error(`Symbolic links/junctions are not accepted: ${resource}`);
      if (names.has(resource.toLowerCase())) throw new Error(`Case-insensitive path collision: ${resource}`);
      names.set(resource.toLowerCase(), resource);
      if (item.isDirectory()) await walk(resource);
      else if (item.isFile()) {
        const absolute = path.join(real, resource);
        const stat = await fs.stat(absolute);
        files.set(resource.toLowerCase(), { path: resource, bytes: stat.size, sha256: await hashFile(absolute) });
      } else throw new Error(`Special files are not accepted: ${resource}`);
    }
  };
  await walk('');
  return { root: real, files, names };
}

function fileFor(inv, requested) {
  const resource = virtualPath(requested);
  const entry = inv.files.get(resource.toLowerCase());
  if (!entry) throw new Error(`Missing resource: ${resource}`);
  return entry.path;
}

async function textFile(inv, resource) {
  const actual = fileFor(inv, resource);
  const entry = inv.files.get(actual.toLowerCase());
  if (entry.bytes > 32 * 1024 * 1024) throw new Error(`Text resource exceeds 32 MiB: ${actual}`);
  const buffer = await fs.readFile(path.join(inv.root, actual));
  if (buffer.includes(0)) throw new Error(`Binary/UTF-16 resource is not supported: ${actual}`);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(buffer);
}

function rootEntry(text, source, kind) {
  const entries = parseDocument(text, { source });
  if (entries.length !== 1 || values(entries[0])[0] !== kind) throw new Error(`${source}: expected ${kind}; already native or unsupported input`);
  return entries[0];
}

async function metaIdentity(inv, resource) {
  const name = `${resource}.meta`;
  if (!inv.files.has(name.toLowerCase())) return null;
  const text = await textFile(inv, name);
  const top = rootEntry(text, name, 'MetaFileClass');
  return parseReference(oneValue(top, 'Name'));
}

export async function planMigration({ root, workspace, assetProfile }) {
  if (!root || !workspace) throw new Error('Both root and workspace are required');
  const inv = await inventory(root);
  if (inv.names.has(REPORT_DIRECTORY.toLowerCase())) throw new Error('Input already contains a migration report; select the original source root');
  const workspacePath = fileFor(inv, virtualPath(workspace));
  if (!workspacePath.toLowerCase().endsWith('.aw')) throw new Error('Workspace must be an .aw file');
  const workspaceText = await textFile(inv, workspacePath);
  const aw = rootEntry(workspaceText, workspacePath, '$animWorkspace');
  const graphPath = fileFor(inv, parseReference(oneValue(aw, '#animGraph')).path);
  const graphText = await textFile(inv, graphPath);
  const graph = rootEntry(graphText, graphPath, '$AnimGraph');
  const templatePath = fileFor(inv, parseReference(oneValue(graph, '#AnimSetTemplate')).path);
  const warnings = [];
  const awTemplate = oneValue(aw, '#animSetTemplate', false);
  if (awTemplate && !samePath(parseReference(awTemplate).path, templatePath)) warnings.push(`Workspace template differs from graph template. The graph's template is authoritative: ${templatePath}`);
  const template = convertTemplate(await textFile(inv, templatePath), { source: templatePath });
  warnings.push(...(template.warnings ?? []));
  const qualifySource = template.qualifySource;
  if (typeof qualifySource !== 'function') throw new Error('Template converter did not provide a source resolver');
  const converted = new Map();
  const skipped = new Set();
  const generatedIds = new Map();
  const allIds = new Map();
  const activeDeclaredIds = new Map();
  const namespace = `AnimGraphMigration:v1:${workspacePath.toLowerCase()}`;
  const idFor = resource => {
    if (!generatedIds.has(resource)) {
      const guid = deterministicGuid(namespace, resource);
      if ([...generatedIds.values()].includes(guid)) throw new Error('Generated GUID collision');
      generatedIds.set(resource, guid);
    }
    return generatedIds.get(resource);
  };
  const resourceRef = resource => refString(resource, idFor(resource));
  const add = (resource, content, type) => {
    if (converted.has(resource)) throw new Error(`Multiple writers for output resource: ${resource}`);
    if (inv.names.has(resource.toLowerCase()) && !inv.files.has(resource.toLowerCase())) throw new Error(`Output file would collide with a source directory: ${resource}`);
    converted.set(resource, content);
    converted.set(`${resource}.meta`, generateMeta(resource, idFor(resource), type));
  };
  const dependencies = [];
  const checkDependency = async original => {
    const ref = parseReference(original);
    const actual = fileFor(inv, ref.path);
    const meta = await metaIdentity(inv, actual);
    if (ref.guid && meta?.guid && ref.guid !== meta.guid) throw new Error(`Asset GUID mismatch: ${actual}`);
    if (meta && !samePath(meta.path, actual)) warnings.push(`Existing asset metadata names another import path: ${actual} -> ${meta.path}; preserved unchanged`);
    const guid = ref.guid ?? meta?.guid;
    if (guid) {
      if (allIds.has(guid) && !samePath(allIds.get(guid), actual)) throw new Error(`External asset GUID collision: ${actual}`);
      allIds.set(guid, actual);
      activeDeclaredIds.set(guid, meta?.path ?? actual);
    }
    dependencies.push({ path: actual, guid });
    return guid ? refString(actual, guid) : actual;
  };
  add(templatePath, template.text, 'ast');
  const instancePaths = get(aw, '#animSetInstance').map(entry => {
    const tokens = values(entry);
    if (tokens.length !== 2) throw new Error('Invalid #animSetInstance entry');
    return fileFor(inv, parseReference(tokens[1]).path);
  });
  if (!instancePaths.length) throw new Error('Workspace has no animation set instance');
  if (new Set(instancePaths.map(p => p.toLowerCase())).size !== instancePaths.length) throw new Error('Duplicate workspace instance');
  let assignments = 0;
  const activeAssignments = [];
  for (const resource of instancePaths) {
    const text = await textFile(inv, resource);
    const asi = rootEntry(text, resource, '$animsetinstance');
    const oldTemplate = parseReference(oneValue(asi, '#template')).path;
    if (!samePath(oldTemplate, templatePath)) throw new Error(`Instance template differs from graph template: ${resource}`);
    const result = convertInstance(text, { source: resource, templateRef: resourceRef(templatePath), qualifySource });
    for (const assignment of result.assignments) {
      await checkDependency(assignment.resource);
      activeAssignments.push({ ...assignment, instance: resource });
    }
    assignments += result.assignments.length;
    warnings.push(...(result.warnings ?? []));
    add(resource, result.text, 'asi');
  }
  const fileBlocks = get(graph, '$Files');
  if (fileBlocks.length !== 1 || fileBlocks[0].children === null) throw new Error('Graph requires one $Files block');
  const graphFiles = fileBlocks[0].children.map(entry => {
    const tokens = values(entry);
    if (entry.children !== null || tokens.length !== 1) throw new Error('Invalid graph file reference');
    return fileFor(inv, parseReference(tokens[0]).path);
  });
  if (!graphFiles.length) throw new Error('Graph has no graph files');
  if (new Set(graphFiles.map(p => p.toLowerCase())).size !== graphFiles.length) throw new Error('Duplicate graph file');
  const graphRefs = [];
  const graphStatistics = [];
  const graphInputs = await Promise.all(graphFiles.map(async resource => {
    const text = await textFile(inv, resource);
    return { resource, text, ...inspectGraphFile(text, { source: resource }) };
  }));
  for (const legacyPath of graphFiles) {
    if (!legacyPath.toLowerCase().endsWith('.agr') || samePath(legacyPath, graphPath)) throw new Error(`Unsupported graph file path: ${legacyPath}`);
    const nativePath = legacyPath.replace(/\.agr$/iu, '.agf');
    if (inv.names.has(nativePath.toLowerCase()) || inv.names.has(`${nativePath}.meta`.toLowerCase())) throw new Error(`Native output already exists in source: ${nativePath}`);
    const graphInput = graphInputs.find(item => item.resource === legacyPath);
    const externalNodeNames = graphInputs.filter(item => item.resource !== legacyPath).flatMap(item => item.nodeNames);
    const result = convertGraphFile(graphInput.text, { source: legacyPath, qualifySource, externalNodeNames });
    add(nativePath, result.text, 'agf');
    skipped.add(legacyPath.toLowerCase());
    skipped.add(`${legacyPath}.meta`.toLowerCase());
    graphRefs.push(resourceRef(nativePath));
    graphStatistics.push({ input: legacyPath, output: nativePath, ...result.stats });
    warnings.push(...(result.warnings ?? []));
  }
  const wrapper = convertGraphRoot(graphText, { source: graphPath, templateRef: resourceRef(templatePath), graphRefs });
  warnings.push(...(wrapper.warnings ?? []));
  add(graphPath, wrapper.text, 'agr');
  const preview = oneValue(aw, '#previewModel', false);
  const modelRef = preview ? await checkDependency(preview) : undefined;
  const eventTable = oneValue(aw, '#eventTable', false);
  if (eventTable) await checkDependency(eventTable);
  const workspaceResult = convertWorkspace(workspaceText, { source: workspacePath, workspaceRef: resourceRef(workspacePath), templateRef: resourceRef(templatePath), instanceRefs: instancePaths.map(resourceRef), graphRef: resourceRef(graphPath), modelRef });
  add(workspacePath, workspaceResult.text, 'aw');
  warnings.push(...(workspaceResult.warnings ?? []));
  for (const [resource, guid] of generatedIds) if (allIds.has(guid)) throw new Error(`Generated resource GUID collides with external asset: ${resource}`);
  // Copied but unselected metadata is mounted too: it must not collide with new identities.
  const outputIds = new Map([...generatedIds].map(([resource, guid]) => [guid, resource]));
  const convertedKeys = new Set([...converted.keys()].map(name => name.toLowerCase()));
  for (const file of inv.files.values()) {
    if (!file.path.toLowerCase().endsWith('.meta') || skipped.has(file.path.toLowerCase()) || convertedKeys.has(file.path.toLowerCase())) continue;
    const underlying = file.path.slice(0, -5);
    const identity = await metaIdentity(inv, underlying);
    if (!identity?.guid) throw new Error(`Metadata has no resource GUID: ${file.path}`);
    if ([...generatedIds.values()].includes(identity.guid)) throw new Error(`Preserved metadata collides with a generated resource GUID: ${file.path}`);
    if (activeDeclaredIds.has(identity.guid) && !samePath(activeDeclaredIds.get(identity.guid), identity.path)) throw new Error(`Preserved metadata collides with an active asset GUID: ${file.path}`);
    const prior = outputIds.get(identity.guid);
    // Import aliases (.anm/.fbx) predate migration; allow only identical declared resource identities.
    if (prior && !samePath(prior, identity.path)) throw new Error(`Preserved metadata GUID collision: ${file.path} and ${prior}`);
    outputIds.set(identity.guid, identity.path);
  }
  let assetMigration = null;
  if (assetProfile !== undefined) {
    if (typeof assetProfile !== 'string' || !assetProfile) throw new Error('Asset profile must be a nonempty supported profile ID');
    const assetPlan = validateAssetProfile({ profileId: assetProfile, inventory: inv.files, activeAssignments });
    const jobs = [];
    for (const job of assetPlan.jobs) {
      if (job.action !== 'transform-root-motion') { jobs.push(job); continue; }
      const original = await textFile(inv, job.txa.path);
      const migrated = migrateRootMotionTxa(original, { source: job.txa.path });
      if (migrated.report.sourceSha256 !== job.txa.sha256) throw new Error(`TXA changed after profile validation: ${job.txa.path}`);
      if (converted.has(job.txa.path)) throw new Error(`Multiple writers for TXA: ${job.txa.path}`);
      converted.set(job.txa.path, migrated.text);
      jobs.push({ ...job, preparedTxaSha256: digest(migrated.text), migration: migrated.report });
    }
    const transformed = jobs.filter(job => job.migration);
    if (transformed.length !== assetPlan.requiredClipCount) throw new Error('Asset plan transformation count differs from the required native import count');
    const assetPlanPath = `${REPORT_DIRECTORY}/assets.json`;
    converted.set(assetPlanPath, json({ ...assetPlan, status: 'awaiting-native-import', jobs }));
    assetMigration = {
      profileId: assetPlan.profileId, profileVersion: assetPlan.profileVersion, planId: assetPlan.planId,
      planPath: assetPlanPath, status: 'awaiting-native-import',
      transformedClips: transformed.length, unchangedClips: assetPlan.unchangedClipCount,
      nativeImportRequired: true, runtimeTestEligible: false, runtimeValidation: 'not-validated',
      pendingAnms: transformed.map(job => job.anm.path),
    };
    warnings.push('Animation sources are prepared, but their ANMs still contain original release bytes. Complete native import and validation before packaging or gameplay tests.');
  }
  const report = {
    tool: 'AnimGraphMigration', version: VERSION, workspace: workspacePath, template: templatePath,
    mode: 'direct-legacy-conversion', inputFiles: inv.files.size, generatedFiles: converted.size,
    instances: instancePaths.length, assignments, graphFiles: graphStatistics, controls: wrapper.stats,
    dependencies: [...new Map(dependencies.map(item => [item.path, item])).values()],
    assetMigration,
    resources: [...generatedIds].map(([resource, guid]) => ({ path: resource, guid })),
    warnings: [...new Set(warnings)],
    limitations: ['Only the selected workspace and its active graph/template/instances are converted.', 'Runtime compatibility, visible animation, model imports, and material correctness require separate Experimental Workbench and game tests.'],
  };
  return { inv, converted, skipped, report };
}

function relatedPaths(a, b) {
  const relative = path.relative(a.toLowerCase(), b.toLowerCase());
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Shared copy/inventory safeguards for the separate native-import workflow.
export { inventory as inventoryProject, textFile as textProjectFile, relatedPaths as relatedProjectPaths };

export async function convertProject(options) {
  if (!options.output) throw new Error('Output is required');
  const output = path.resolve(options.output);
  const input = path.resolve(options.root);
  if (relatedPaths(input, output) || relatedPaths(output, input)) throw new Error('Output must be separate from input, never the same directory, a child, or an ancestor');
  await assertNoLinks(output);
  if (await exists(output)) throw new Error('Output already exists; choose a new directory. Nothing overwritten.');
  const plan = await planMigration(options);
  if (relatedPaths(plan.inv.root, output) || relatedPaths(output, plan.inv.root)) throw new Error('Input and output overlap after path resolution');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.migration-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    for (const [key, file] of plan.inv.files) {
      if (plan.skipped.has(key)) continue;
      const destination = path.join(staging, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(plan.inv.root, file.path), destination);
    }
    for (const [resource, content] of plan.converted) {
      const destination = path.join(staging, resource);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content, 'utf8');
    }
    const after = await inventory(plan.inv.root);
    if (after.files.size !== plan.inv.files.size || [...plan.inv.files].some(([key, file]) => after.files.get(key)?.sha256 !== file.sha256)) throw new Error('Input changed during migration; no final output published');
    const outputInventory = await inventory(staging);
    const convertedKeys = new Set([...plan.converted.keys()].map(name => name.toLowerCase()));
    for (const [key, original] of plan.inv.files) {
      if (plan.skipped.has(key) || convertedKeys.has(key)) continue;
      if (outputInventory.files.get(key)?.sha256 !== original.sha256) throw new Error(`Copied file does not match source: ${original.path}`);
    }
    const report = { ...plan.report, createdUtc: new Date().toISOString(), sourceUnchanged: true };
    const reportPath = `${REPORT_DIRECTORY}/report.json`;
    const reportText = json(report);
    const entries = [...outputInventory.files.values()].sort((a, b) => a.path.localeCompare(b.path));
    entries.push({ path: reportPath, bytes: Buffer.byteLength(reportText), sha256: digest(reportText) });
    const manifest = { schema: 1, algorithm: 'SHA-256', files: entries };
    await fs.mkdir(path.join(staging, REPORT_DIRECTORY), { recursive: true });
    await fs.writeFile(path.join(staging, reportPath), reportText);
    await fs.writeFile(path.join(staging, REPORT_DIRECTORY, 'manifest.json'), json(manifest));
    await verifyProject({ root: staging });
    await assertNoLinks(output);
    if (await exists(output)) throw new Error('Output appeared during conversion; no overwrite performed');
    await fs.rename(staging, output);
    return { ...report, output };
  } catch (error) {
    // The random sibling is exclusively ours; never remove source or final output.
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyProject({ root }) {
  const inv = await inventory(root);
  const manifest = JSON.parse(await textFile(inv, `${REPORT_DIRECTORY}/manifest.json`));
  if (manifest.schema !== 1 || manifest.algorithm !== 'SHA-256' || !Array.isArray(manifest.files)) throw new Error('Unsupported manifest');
  const expected = new Map();
  for (const entry of manifest.files) {
    const resource = virtualPath(entry.path);
    const key = resource.toLowerCase();
    if (expected.has(key)) throw new Error(`Duplicate manifest entry: ${resource}`);
    expected.set(key, entry);
    const file = inv.files.get(key);
    if (!file || file.sha256 !== entry.sha256 || file.bytes !== entry.bytes) throw new Error(`Integrity check failed: ${resource}`);
  }
  const actual = [...inv.files.keys()].filter(key => key !== `${REPORT_DIRECTORY}/manifest.json`);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) throw new Error('Unexpected files in output');
  const report = JSON.parse(await textFile(inv, `${REPORT_DIRECTORY}/report.json`));
  const identities = new Map();
  for (const resource of report.resources) {
    virtualPath(resource.path);
    const meta = await metaIdentity(inv, resource.path);
    if (!meta || meta.guid !== resource.guid || !samePath(meta.path, resource.path)) throw new Error(`Resource metadata mismatch: ${resource.path}`);
    if (identities.has(meta.guid)) throw new Error(`Resource GUID collision: ${resource.path}`);
    identities.set(meta.guid, resource.path);
    const entries = parseDocument(await textFile(inv, resource.path), { source: resource.path });
    const refs = [];
    const referenceFields = new Set(['AnimSetTemplate', 'Template', 'AnimGraph', 'Resource', 'Model', 'EventTable', 'SyncTable']);
    const visit = (items, parent = '') => {
      for (const item of items) {
        const tokens = values(item);
        for (const token of tokens) if (/^\{[a-f0-9]{16}\}.+/iu.test(token)) refs.push(token);
        if (referenceFields.has(tokens[0]) && tokens[1]) refs.push(tokens[1]);
        if ((parent === 'GraphFiles' || parent === 'AnimSetInstances') && !item.children && tokens[0]) refs.push(tokens[0]);
        if (tokens[0] === 'BaseSource' && tokens[1]) refs.push(tokens[1]);
        if (item.children) visit(item.children, tokens[0]);
      }
    };
    visit(entries);
    for (const original of new Set(refs)) {
      const target = parseReference(original);
      const actualPath = fileFor(inv, target.path);
      const targetMeta = await metaIdentity(inv, actualPath);
      if (target.guid && targetMeta?.guid && target.guid !== targetMeta.guid) throw new Error(`Internal resource GUID mismatch in ${resource.path}: ${target.path}`);
      const generatedTarget = report.resources.find(item => samePath(item.path, actualPath));
      if (generatedTarget && target.guid !== generatedTarget.guid) throw new Error(`Internal generated reference is missing or has an incorrect GUID: ${target.path}`);
    }
  }
  for (const dependency of report.dependencies) {
    fileFor(inv, dependency.path);
    const meta = await metaIdentity(inv, dependency.path);
    if (dependency.guid && meta?.guid && dependency.guid !== meta.guid) throw new Error(`External GUID mismatch: ${dependency.path}`);
  }
  return {
    valid: true, checkedFiles: expected.size, resources: report.resources.length, workspace: report.workspace,
    assetMigration: report.assetMigration ?? null,
  };
}
