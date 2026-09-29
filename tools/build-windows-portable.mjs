#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Deliberately explicit: private evidence, tests, caches and new files cannot enter a release automatically.
export const APP_FILES = Object.freeze([
  'README.md', 'README.de.md', 'README.en.md', 'LICENSE', 'package.json',
  'bin/animgraph-migration-general.mjs', 'web/index.html', 'assets/logo.svg', 'assets/wordmark.svg',
  'docs/format-support.md', 'docs/validation.md', 'docs/images/desktop.png',
  'src/commands.mjs', 'src/graph.mjs', 'src/project.mjs',
  'src/resources.mjs', 'src/server.mjs', 'src/syntax.mjs',
]);

export function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = {};
  const flags = { '--runtime':'runtime', '--output':'output', '--webview2-sdk':'webview2Sdk' };
  for (let index = 0; index < args.length; index += 2) {
    const key = Object.hasOwn(flags, args[index]) ? flags[args[index]] : undefined, value = args[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Expected --runtime DIR --webview2-sdk DIR --output NEW.zip');
    options[key] = value;
  }
  if (!options.runtime || !options.webview2Sdk || !options.output) throw new Error('Expected --runtime DIR --webview2-sdk DIR --output NEW.zip');
  return options;
}

export function validateWindowsAmd64Pe(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('node.exe is not a Windows PE executable');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset > bytes.length - 26 || bytes.readUInt32LE(offset) !== 0x00004550) throw new Error('Invalid PE header');
  const optionalSize = bytes.readUInt16LE(offset + 20);
  if (bytes.readUInt16LE(offset + 4) !== 0x8664 || !(bytes.readUInt16LE(offset + 22) & 2) || optionalSize < 2 || offset + 24 + optionalSize > bytes.length || bytes.readUInt16LE(offset + 24) !== 0x20b) throw new Error('Runtime must be an AMD64 PE32+ executable');
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
const quotePowerShell = value => "'" + value.replaceAll("'", "''") + "'";

async function noLinks(target) {
  let current = path.resolve(target);
  while (true) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Links/junctions are not allowed: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (path.resolve(await fs.realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()) throw new Error(`Redirected path is not allowed: ${target}`);
}

async function absent(file) {
  try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists: ${file}`);
}

async function readSource(file, maxBytes) {
  await noLinks(file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error(`Invalid source file or size: ${file}`);
  const bytes = await fs.readFile(file);
  if (bytes.length !== stat.size) throw new Error(`Source changed while reading: ${file}`);
  return { source: file, bytes, sha256: hash(bytes) };
}

async function unchanged(sources) {
  for (const source of sources) {
    const current = await readSource(source.source, source.bytes.length);
    if (current.sha256 !== source.sha256) throw new Error(`Source changed during packaging: ${source.source}`);
  }
}

export async function buildPortable({ runtime, webview2Sdk, output }) {
  if (process.platform !== 'win32') throw new Error('The portable builder requires Windows PowerShell and the built-in .NET ZIP library');
  runtime = path.resolve(runtime); webview2Sdk = path.resolve(webview2Sdk); output = path.resolve(output);
  const outputParent = path.dirname(output);
  const outputName = path.basename(output);
  if (!/\.zip$/i.test(outputName) || /[<>:"|?*\x00-\x1f]/u.test(outputName) || /[. ]$/u.test(outputName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(outputName)) throw new Error('Output must have a valid new Windows .zip filename');
  await noLinks(repository); await noLinks(runtime); await noLinks(webview2Sdk); await noLinks(outputParent);
  if (!(await fs.stat(runtime)).isDirectory() || !(await fs.stat(outputParent)).isDirectory()) throw new Error('Runtime and output parent must be existing directories');
  if (inside(repository, output) || inside(runtime, output) || inside(webview2Sdk, output)) throw new Error('Write the release ZIP outside the source repository and runtime/SDK directories');
  await absent(output);

  const sources = [];
  for (const relative of APP_FILES) sources.push({ ...await readSource(path.join(repository, relative), 8 * 1024 * 1024), target: 'app/' + relative });
  for (const name of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'LICENSE.txt', 'NOTICE.txt']) sources.push({ ...await readSource(path.join(webview2Sdk, name), 8 * 1024 * 1024), target: name.endsWith('.dll') ? name : 'runtime/webview2/' + name });
  const launcherSource = await readSource(path.join(repository, 'tools/windows/Launcher.cs'), 256 * 1024);
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await noLinks(compiler);
  if (!(await fs.stat(compiler)).isFile()) throw new Error('The Windows .NET Framework x64 C# compiler is required');
  const executable = { ...await readSource(path.join(runtime, 'node.exe'), 256 * 1024 * 1024), target: 'runtime/node/node.exe' };
  const license = { ...await readSource(path.join(runtime, 'LICENSE'), 4 * 1024 * 1024), target: 'runtime/node/LICENSE' };
  validateWindowsAmd64Pe(executable.bytes);
  if (!/Node\.js|Node contributors/i.test(license.bytes.toString('utf8'))) throw new Error('Runtime LICENSE does not identify Node.js');
  sources.push(executable, license);
  const runtimeCheck = spawnSync(executable.source, ['--eval', 'process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch}))'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 65536,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  if (runtimeCheck.error || runtimeCheck.status !== 0) throw new Error(`Runtime version check failed: ${runtimeCheck.error?.message ?? runtimeCheck.stderr}`);
  let node;
  try { node = JSON.parse(runtimeCheck.stdout); } catch { throw new Error('Runtime returned an invalid version report'); }
  if (!/^\d+\.\d+\.\d+$/.test(node.version) || Number(node.version.split('.')[0]) < 22 || node.platform !== 'win32' || node.arch !== 'x64') throw new Error('Runtime must be Node.js >=22 for Windows x64');
  const pkg = JSON.parse(sources.find(source => source.target === 'app/package.json').bytes.toString('utf8'));
  const version = /export const VERSION = ['"]([^'"]+)['"]/.exec(sources.find(source => source.target === 'app/src/project.mjs').bytes.toString('utf8'))?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version !== version) throw new Error('package.json and program VERSION must match before packaging');
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) throw new Error('The fixed portable package does not install npm dependencies');
  await unchanged([...sources, launcherSource]);

  const temp = await fs.mkdtemp(path.join(outputParent, '.agm-portable-'));
  const payload = path.join(temp, 'payload'), temporaryZip = path.join(temp, 'package.zip');
  let cleanupError;
  try {
    const localLauncherSource = path.join(temp, 'Launcher.cs'), launcherOutput = path.join(temp, 'AnimGraphMigration.exe');
    await fs.writeFile(localLauncherSource, launcherSource.bytes, { flag: 'wx' });
    const compilation = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warnaserror+', '/codepage:65001', '/out:' + launcherOutput, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:' + path.join(webview2Sdk, 'Microsoft.Web.WebView2.Core.dll'), '/reference:' + path.join(webview2Sdk, 'Microsoft.Web.WebView2.WinForms.dll'), localLauncherSource], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 1024 * 1024 });
    if (compilation.error || compilation.status !== 0) throw new Error(`EXE launcher compilation failed: ${compilation.error?.message ?? compilation.stdout + compilation.stderr}`);
    const launcher = await fs.readFile(launcherOutput);
    validateWindowsAmd64Pe(launcher);
    if (launcher.readUInt16LE(launcher.readUInt32LE(0x3c) + 24 + 68) !== 2) throw new Error('Desktop launcher must use the Windows GUI subsystem');
    const portablePackage = { ...pkg, bin: { 'animgraph-migration':'bin/animgraph-migration-general.mjs' }, scripts: { start:'node bin/animgraph-migration-general.mjs', gui:'node bin/animgraph-migration-general.mjs serve' } };
    const entries = sources.map(source => ({ target: source.target, bytes: source.target === 'app/package.json' ? Buffer.from(JSON.stringify(portablePackage, null, 2) + '\n', 'utf8') : source.bytes }));
    entries.push({ target: 'AnimGraphMigration.exe', bytes: launcher });
    entries.push({ target: 'PORTABLE.txt', bytes: Buffer.from(`AnimGraphMigration ${version} - Windows x64 desktop\r\n\r\nExtract the entire ZIP, then double-click AnimGraphMigration.exe.\r\nThe application opens its own window. English is the default; DE/EN/CS can be selected in the interface.\r\nNode.js ${node.version} runs hidden in the background; no Node installation or PATH change is needed.\r\nClosing the application window stops the local service.\r\nRequires .NET Framework 4.6.2+ and Microsoft Edge WebView2 Evergreen Runtime.\r\nIf WebView2 is missing, the application offers Microsoft's download page after a click; it never installs automatically.\r\nPortable browser data is stored in the writable data/WebView2 folder beside the EXE.\r\n\r\nProgram license: app/LICENSE (MIT).\r\nNode.js license/notices: runtime/node/LICENSE. https://nodejs.org/\r\nMicrosoft WebView2 SDK license/notices: runtime/webview2/LICENSE.txt and NOTICE.txt.\r\nThis general DayZ 1.30 graph converter includes no game files, mod assets or specialized clip/model migration.\r\n`, 'utf8') });
    const manifest = { schema: 1, product: 'AnimGraphMigration', version, edition: 'general', generatedChanges: ['app/package.json bin/start/gui point only to the general CLI'], launcher: { sourceSha256: launcherSource.sha256, sha256: hash(launcher), type: 'Windows x64 WinForms/WebView2 GUI EXE', compiler: '.NET Framework 4 csc' }, webview2: { runtimeBundled: false, sdkFiles: sources.filter(source => source.target.includes('WebView2') || source.target.startsWith('runtime/webview2/')).map(source => ({ path:source.target,sha256:source.sha256 })) }, runtime: { version: node.version, platform: node.platform, arch: node.arch, sha256: executable.sha256, licenseSha256: license.sha256 }, files: entries.map(entry => ({ path: entry.target, bytes: entry.bytes.length, sha256: hash(entry.bytes) })) };
    entries.push({ target: 'PORTABLE-MANIFEST.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') });
    for (const entry of entries) {
      const destination = path.join(payload, entry.target);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.bytes, { flag: 'wx' });
    }
    const expected = new Map(entries.map(entry => [entry.target, { bytes: entry.bytes.length, sha256: hash(entry.bytes) }]));
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(${quotePowerShell(payload)},${quotePowerShell(temporaryZip)},[IO.Compression.CompressionLevel]::Optimal,$false)
$zip=[IO.Compression.ZipFile]::OpenRead(${quotePowerShell(temporaryZip)})
try {
  $rows=@(foreach($entry in $zip.Entries) {
    if($entry.FullName.EndsWith('/')) { continue }
    $stream=$entry.Open(); $hasher=[Security.Cryptography.SHA256]::Create()
    try { $digest=([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $hasher.Dispose() }
    [pscustomobject]@{path=$entry.FullName.Replace('\\','/');bytes=$entry.Length;sha256=$digest}
  })
  ConvertTo-Json -InputObject $rows -Compress
} finally { $zip.Dispose() }
`;
    const compressed = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 300000, maxBuffer: 1024 * 1024 });
    if (compressed.error || compressed.status !== 0) throw new Error(`ZIP creation failed: ${compressed.error?.message ?? compressed.stderr}`);
    let actual;
    try { actual = JSON.parse(compressed.stdout.replace(/^\uFEFF/, '').trim()); } catch { throw new Error('ZIP verification did not return its entry manifest'); }
    if (!Array.isArray(actual) || actual.length !== expected.size) throw new Error('ZIP has an unexpected file count');
    const seen = new Set();
    for (const entry of actual) {
      const known = expected.get(entry.path);
      if (!known || seen.has(entry.path) || Number(entry.bytes) !== known.bytes || entry.sha256 !== known.sha256) throw new Error(`Unexpected or corrupt ZIP entry: ${entry.path}`);
      seen.add(entry.path);
    }
    await unchanged([...sources, launcherSource]);
    await noLinks(outputParent); await absent(output);
    // COPYFILE_EXCL protects a concurrently created destination; never replace another build.
    await fs.copyFile(temporaryZip, output, constants.COPYFILE_EXCL);
    const archive = await fs.readFile(output);
    if (hash(archive) !== hash(await fs.readFile(temporaryZip))) throw new Error('Final ZIP copy failed its integrity check');
    return { output, version, runtimeVersion: node.version, launcher: manifest.launcher, files: expected.size, bytes: archive.length, sha256: hash(archive), verified: true, sourceUnchanged: true, runtimeUnchanged: true };
  } finally {
    try {
      // Only remove the exact directory created above, after checking its absolute parent and identity.
      if (path.dirname(temp) !== outputParent || !path.basename(temp).startsWith('.agm-portable-') || !inside(outputParent, temp)) throw new Error('Unsafe temporary cleanup path');
      await noLinks(temp);
      await fs.rm(temp, { recursive: true, force: false });
    } catch (error) { cleanupError = error; }
    if (cleanupError) console.error(`Temporary build directory retained: ${temp}: ${cleanupError.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node tools/build-windows-portable.mjs --runtime DIR --webview2-sdk DIR --output NEW.zip\nRuntime DIR requires Windows x64 node.exe (Node >=22) and its matching LICENSE.\nSDK DIR requires the official WebView2 Core/WinForms DLLs, x64 WebView2Loader.dll, LICENSE.txt and NOTICE.txt.\nRun on Windows with the .NET Framework C# compiler. Output parent must exist outside source/runtime/SDK. Existing ZIPs are never overwritten.');
    else console.log(JSON.stringify(await buildPortable(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
