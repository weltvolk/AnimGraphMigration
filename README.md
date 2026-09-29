![AnimGraphMigration](assets/wordmark.svg)

# AnimGraphMigration

[English](README.md) | [Deutsch](README.de.md)

AnimGraphMigration converts supported legacy DayZ AnimGraphs, workspaces, templates and instances into the examined DayZ 1.30 format. **Graph conversion is independent of the mod:** support depends on the file constructs used. The converter works with copies and writes exclusively to a new output folder.

## Download the Windows application

**[Download AnimGraphMigration 1.1.0 for Windows x64](https://github.com/weltvolk/AnimGraphMigration/releases/download/v1.1.0/AnimGraphMigration-1.1.0-Windows-x64.zip)**

1. Extract the entire ZIP, for example into `H:\Tools\AnimGraphMigration`.
2. Double-click **`AnimGraphMigration.exe`** in the extracted top-level folder. It opens the application's own desktop window.
3. The application starts in **English**. Select **Deutsch** or **Čeština** if preferred.

The application is portable: no application installer or separate Node.js installation is required. The ZIP includes the required Node.js runtime and its license. Keep all extracted files and folders together; the EXE alone is not sufficient. The desktop window requires .NET Framework 4.6.2 or newer and Microsoft Edge WebView2 Evergreen Runtime. If it is missing, the launcher explains how to obtain it; it does not install it automatically. Node.js runs in the background, and closing the application window stops its local service.

See the [v1.1.0 release page](https://github.com/weltvolk/AnimGraphMigration/releases/tag/v1.1.0) for the release. GitHub's **Source code** archives contain source code; use the named ZIP above for the ready-to-run Windows application. DayZ Tools, game data and mod files are not included.

![AnimGraphMigration desktop interface](docs/images/desktop.png)

## Supported scope

| Area | Support |
|---|---|
| Graph format | The explicitly supported subset of legacy `$AnimGraph 7`. |
| Node types | `AnimNodeStateMachine`, `AnimNodeSource` and `AnimNodeSwitch`, with the documented fields and flags. |
| Resources | Legacy `.aw`, `.agr`, `.asi` and a matching `.ast`, with consistent references and resource metadata. |
| Templates and instances | Legacy AST with exactly one unnamed group type; legacy ASI without inheritance. Known native templates are also supported. |
| Models and animation clips | Copied unchanged. No model, skeleton, TXA or ANM conversion. |
| Unknown constructs | An explicit error, rather than silently discarding fields. |

The tool is intended for projects from different mods using these constructs. **Compatibility with every mod is not claimed.** Additional nodes, unimplemented fields or ambiguous references require a specific extension.

Supported graph details include `realtime` and `notime` state modes, `loop` and `noloop` source modes, and the observed transition blend value `S`. Nonempty predictions or control expressions, unsupported flags and unknown semantic fields are rejected. Legacy templates require `#ngroupnames 0` with one group type; legacy instances require `#nparents 0`. Slot names and references must be unique and resolvable. The CLI expects legacy workspaces, graphs and instances, not arbitrary mixtures of native and legacy resources.

**Status: limited format support.** Output follows files examined with DayZ Experimental Workbench **1.30.164014.27**. Successful conversion and integrity checks establish the supported file mapping, not complete gameplay behavior. Test your own mod in the editor and game afterward; other tool builds also require separate validation.

See [format support](docs/format-support.md) for the exact supported constructs and the [validation guide](docs/validation.md) for editor and game checks.

## Requirements

- Unpacked, editable source files. The tool does not extract PBOs.
- A project root containing virtual mod paths. For `ExampleMod/anims/example.aw`, `<root>/ExampleMod/anims/example.aw` must exist.
- All directly referenced graph, template, instance, clip and preview-model files inside that root. Missing direct dependencies cause an error.
- A new output folder outside the input project. Existing output folders are not overwritten.
- For subsequent editor checks: matching DayZ 1.30 Tools and game data.
- For a source checkout only: install **Node.js 22 or newer**. No additional npm packages are required.

Use the smallest complete project root containing the required resources. The converter does not resolve further dependencies inside binary models or the engine.

## Desktop interface

1. Launch `AnimGraphMigration.exe`.
2. Enter the full **source folder**, for example `H:\DayZProjects\MyModLegacy`.
3. Enter the **workspace path relative to that folder**, for example `ExampleMod/anims/example.aw`.
4. Enter a **new output folder**, for example `H:\DayZProjects\MyMod130`.
5. Inspect the source, convert it, then verify the output. Open the report for details.

The interface processes local files and does not upload mod files. Close the desktop window to stop the application and its background service.

The general CLI also provides `serve` for using the interface in a browser. From a source checkout, run `node bin/animgraph-migration-general.mjs serve` and open the complete local URL printed in the terminal; keep that terminal open and press `Ctrl+C` to stop the service. Add `--open` when invoking `serve` directly to open the browser automatically.

## Command line

From the portable package's top-level folder:

```powershell
.\runtime\node\node.exe .\app\bin\animgraph-migration-general.mjs inspect --root "H:\DayZProjects\MyModLegacy" --workspace "ExampleMod/anims/example.aw"
.\runtime\node\node.exe .\app\bin\animgraph-migration-general.mjs convert --root "H:\DayZProjects\MyModLegacy" --workspace "ExampleMod/anims/example.aw" --output "H:\DayZProjects\MyMod130"
.\runtime\node\node.exe .\app\bin\animgraph-migration-general.mjs verify --root "H:\DayZProjects\MyMod130"
```

Alternatively, from a source checkout with Node.js installed:

```powershell
node bin/animgraph-migration-general.mjs inspect --root "H:\DayZProjects\MyModLegacy" --workspace "ExampleMod/anims/example.aw"
node bin/animgraph-migration-general.mjs convert --root "H:\DayZProjects\MyModLegacy" --workspace "ExampleMod/anims/example.aw" --output "H:\DayZProjects\MyMod130"
node bin/animgraph-migration-general.mjs verify --root "H:\DayZProjects\MyMod130"
node bin/animgraph-migration-general.mjs serve --open
```

| Command | Effect |
|---|---|
| `inspect --root DIR --workspace PATH` | Check the selected workspace and dependencies without writing a conversion. |
| `convert --root DIR --workspace PATH --output NEW_DIR` | Copy the project into a new folder and convert supported resources. |
| `verify --root CONVERTED_DIR` | Check the generated output against its manifest and resource references. |
| `serve [--port 0] [--open]` | Start the local browser interface; port `0` selects an available port. |

Reports are stored in the output at `.animgraph-migration/report.json` and `.animgraph-migration/manifest.json`. Source checksums are compared before and after conversion. Exit code `0` means success, `1` means validation or conversion failed, and `2` means the CLI invocation was invalid.

Only the selected workspace's file set is converted. Other legacy files in the project are copied without conversion. The active old main graph is replaced by a new `.agf` in the output; the original input remains intact.

## Check your own mod

1. Run `verify` and retain its report.
2. Open a separate test copy of the output in the matching Workbench. Copied `.gproj` files remain unchanged: review absolute mounts and redirect them to the test copy first. Do not mount the original and output together where resource identities could collide.
3. Open the `.aw` and `.agr`; record exact errors, console logs and the tool build.
4. Compare states, transitions, conditions, switch values and clip assignments with the source. Count assignments before and after a native save, and reopen the saved result.
5. Check the preview model, skeleton, bone names, materials and visible clip playback.
6. Test your mod separately in the game, including transitions, root motion, ground movement and relevant script/bone queries. For client/server tests, confirm both load the same actual package.

Editor saves change the manifested output, so perform them in a separate test copy. A valid graph does not establish correct animation movement or complete runtime compatibility.

The converter does not create PBOs, run Workbench imports or publish to the Workshop. Models, skeletons and animation clips remain copies of their inputs. Their runtime compatibility is not automatically certified. A mod without its own AnimGraph is outside this conversion workflow; script-driven `AnimationSources` and bone APIs need their own checks.

## Development and issue reports

From a source checkout:

```powershell
npm test
```

Tests use synthetic fixtures and require no private mod or game files. Include the tool version, Node.js version, operating system, command and exact error in an issue. For new constructs, provide a minimal artificial input example and the expected editor output. Remove personal paths and share only files you have permission to publish.

## License

Original tool code and public documentation use the [MIT License](LICENSE). The bundled Node.js runtime retains its included license notices. DayZ, Bohemia Interactive and mod authors retain rights to their products and content. This repository's license grants no rights to processed mod or game files. AnimGraphMigration is an independent tool, not an official Bohemia Interactive release.
