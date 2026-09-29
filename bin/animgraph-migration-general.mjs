#!/usr/bin/env node
import { VERSION } from '../src/project.mjs';
import { GENERAL_COMMAND_SCHEMAS, runGeneralCommand } from '../src/commands.mjs';

const help = `AnimGraphMigration ${VERSION} — general edition
Usage:
  node bin/animgraph-migration-general.mjs inspect --root DIR --workspace Mod/anims/example.aw
  node bin/animgraph-migration-general.mjs convert --root DIR --workspace Mod/anims/example.aw --output NEW_DIR
  node bin/animgraph-migration-general.mjs verify --root CONVERTED_DIR
  node bin/animgraph-migration-general.mjs serve [--port 0] [--open]

Converts supported legacy resources directly into DayZ 1.30 text resources.
Input is never edited. Output must be a new, separate directory.
Animation clips and model assets are copied unchanged. Test converted resources
in DayZ 1.30 Workbench and the game before release.
Results are JSON. Exit codes: 0 success, 1 validation failure, 2 invalid arguments.
`;
const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(help); process.exit(0); }
if (argv[0] === '--version') { console.log(VERSION); process.exit(0); }
const command = argv.shift();
const allowed = Object.fromEntries(Object.entries(GENERAL_COMMAND_SCHEMAS).map(([name, schema]) => [name, [...schema.required, ...schema.optional]]));
allowed.serve = ['port', 'open'];
function usage(message) { console.error(`${message}\n\n${help}`); process.exit(2); }
if (!Object.hasOwn(allowed, command)) usage(`Unknown command: ${command}`);
const options = {};
while (argv.length) {
  const flag = argv.shift();
  const name = flag.startsWith('--') ? flag.slice(2) : '';
  if (command === 'serve' && name === 'open' && !(name in options)) { options.open = true; continue; }
  if (!allowed[command].includes(name) || name in options || !argv.length || argv[0].startsWith('--')) usage(`Invalid argument: ${flag}`);
  options[name] = argv.shift();
}
if (command !== 'serve') for (const field of GENERAL_COMMAND_SCHEMAS[command].required) if (!options[field]) usage(`Missing --${field}`);
try {
  let result;
  if (command !== 'serve') result = await runGeneralCommand(command, options);
  else {
    const { startServer } = await import('../src/server.mjs');
    await startServer({ ...options, generalOnly: true });
  }
  if (result) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, ...(error.source ? { source: error.source, line: error.line, column: error.column } : {}) }, null, 2));
  process.exitCode = 1;
}
