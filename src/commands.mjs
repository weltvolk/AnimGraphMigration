import { planMigration, convertProject, verifyProject } from './project.mjs';

export const COMMAND_SCHEMAS = Object.freeze({
  inspect: { required: ['root', 'workspace'], optional: ['assetProfile'] },
  convert: { required: ['root', 'workspace', 'output'], optional: ['assetProfile'] },
  verify: { required: ['root'], optional: [] },
  'prepare-import': { required: ['root', 'output', 'projectTemplate', 'skeletonDefinitions', 'gameRoot'], optional: [] },
  'verify-import': { required: ['root', 'importRoot'], optional: [] },
  'finalize-import': { required: ['root', 'importRoot', 'output'], optional: [] },
});

export const GENERAL_COMMAND_SCHEMAS = Object.freeze({
  inspect: { required: ['root', 'workspace'], optional: [] },
  convert: { required: ['root', 'workspace', 'output'], optional: [] },
  verify: { required: ['root'], optional: [] },
});

function validateInput(command, input, schemas) {
  if (!Object.hasOwn(schemas, command)) throw new Error('Unknown command');
  const { required, optional } = schemas[command];
  const allowed = [...required, ...optional];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key) || typeof input[key] !== 'string' || !input[key])
    || required.some(key => !Object.hasOwn(input, key))) throw new Error('Invalid request fields');
  return input;
}

export function validateCommandInput(command, input) {
  return validateInput(command, input, COMMAND_SCHEMAS);
}

export async function runGeneralCommand(command, input) {
  validateInput(command, input, GENERAL_COMMAND_SCHEMAS);
  // Pass only validated own fields; inherited options cannot activate optional modules.
  return runCommand(command, Object.fromEntries(Object.entries(input)));
}

export async function runCommand(command, input) {
  validateCommandInput(command, input);
  if (command === 'inspect') return (await planMigration(input)).report;
  if (command === 'convert') return convertProject(input);
  if (command === 'verify') return verifyProject(input);
  const native = await import('./native-import.mjs');
  if (command === 'prepare-import') return native.prepareNativeImport(input);
  if (command === 'verify-import') return native.verifyNativeImport(input);
  return native.finalizeNativeImport(input);
}
