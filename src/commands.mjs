import { planMigration, convertProject, verifyProject } from './project.mjs';

export const COMMAND_SCHEMAS = Object.freeze({
  inspect: { required: ['root', 'workspace'], optional: ['assetProfile'] },
  convert: { required: ['root', 'workspace', 'output'], optional: ['assetProfile'] },
  verify: { required: ['root'], optional: [] },
  'prepare-import': { required: ['root', 'output', 'projectTemplate', 'skeletonDefinitions', 'gameRoot'], optional: [] },
  'verify-import': { required: ['root', 'importRoot'], optional: [] },
  'finalize-import': { required: ['root', 'importRoot', 'output'], optional: [] },
});

export function validateCommandInput(command, input) {
  if (!Object.hasOwn(COMMAND_SCHEMAS, command)) throw new Error('Unknown command');
  const { required, optional } = COMMAND_SCHEMAS[command];
  const allowed = [...required, ...optional];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key) || typeof input[key] !== 'string' || !input[key])
    || required.some(key => !Object.hasOwn(input, key))) throw new Error('Invalid request fields');
  return input;
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
