#!/usr/bin/env node
import { VERSION } from '../src/project.mjs';
import { COMMAND_SCHEMAS, runCommand } from '../src/commands.mjs';

const help = `AnimGraphMigration ${VERSION}
Usage:
  node bin/animgraph-migration.mjs inspect --root DIR --workspace Mod/anims/example.aw [--asset-profile PROFILE_ID]
  node bin/animgraph-migration.mjs convert --root DIR --workspace Mod/anims/example.aw --output NEW_DIR [--asset-profile PROFILE_ID]
  node bin/animgraph-migration.mjs verify --root CONVERTED_DIR
  node bin/animgraph-migration.mjs prepare-import --root PREPARED --output NEW_IMPORT_DIR --project-template TEMPLATE.gproj --skeleton-definitions SKELETONS.anim.xml --game-root GAME_DATA
  node bin/animgraph-migration.mjs verify-import --root PREPARED --import-root IMPORT_DIR
  node bin/animgraph-migration.mjs finalize-import --root PREPARED --import-root IMPORT_DIR --output NEW_VERIFIED_DIR
  node bin/animgraph-migration.mjs serve [--port 0] [--open]

Converts supported legacy resources directly into DayZ 1.30 text resources.
Input is never edited. Output must be a new, separate directory.
Optional source profiles prepare bounded TXAs. Their ANMs require native
DayZ 1.30 Workbench import, verify-import and finalize-import before a game test.
Results are JSON. Exit codes: 0 success, 1 validation failure, 2 invalid arguments.
`;
const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(help); process.exit(0); }
if (argv[0] === '--version') { console.log(VERSION); process.exit(0); }
const command = argv.shift();
const flagName = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const optionName = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const allowed = Object.fromEntries(Object.entries(COMMAND_SCHEMAS).map(([name, schema]) => [name, [...schema.required, ...schema.optional].map(flagName)]));
allowed.serve = ['port', 'open'];
function usage(message) { console.error(`${message}\n\n${help}`); process.exit(2); }
if (!Object.hasOwn(allowed, command)) usage(`Unknown command: ${command}`);
const options = {};
while (argv.length) {
  const flag = argv.shift();
  const name = flag.startsWith('--') ? flag.slice(2) : '';
  if (command === 'serve' && name === 'open' && !(name in options)) { options.open = true; continue; }
  if (!allowed[command].includes(name) || optionName(name) in options || !argv.length || argv[0].startsWith('--')) usage(`Invalid argument: ${flag}`);
  options[optionName(name)] = argv.shift();
}
if (command !== 'serve') for (const field of COMMAND_SCHEMAS[command].required) if (!options[field]) usage(`Missing --${flagName(field)}`);
try {
  let result;
  if (command !== 'serve') result = await runCommand(command, options);
  else {
    const { startServer } = await import('../src/server.mjs');
    await startServer(options);
  }
  if (result) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, ...(error.source ? { source: error.source, line: error.line, column: error.column } : {}) }, null, 2));
  process.exitCode = 1;
}
