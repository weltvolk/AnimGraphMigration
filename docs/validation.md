# Validation and limits of the results

AnimGraphMigration 1.1 converts supported graph resources independently of the mod. Successful conversion establishes the supported file mapping; integrity verification checks the generated file set. Visible preview and gameplay require separate tests of each mod. Models, skeletons and animation clips remain unchanged copies.

## Automated tests

The public test suite uses synthetic inputs and requires no DayZ installation. From a source checkout with Node.js 22 or newer:

```powershell
npm test
```

| Area | Test objective |
|---|---|
| Parser | Read supported structures and fields completely; reject malformed or unknown input explicitly. |
| Graph | Preserve node references, state/transition counts, conditions and supported values. |
| Template and instance | Transfer slots and assignments completely and unambiguously; align qualified names. |
| Resources | Generated references match their targets in path and identity. |
| File protection | Preserve the source; reject existing output, overlapping directories and unsafe link paths. |
| Reproducibility | The same input produces the same resource identities. |
| Failure cases | Unsupported constructs fail rather than produce incomplete successful output. |
| Interface and CLI | Check inputs, required fields, error handling and local access restrictions. |

Each test establishes only the cases it actually covers. Synthetic tests and operating-system checks do not replace Workbench or gameplay validation of a particular mod.

## Basis of format knowledge

Target-format decisions come from native files examined with DayZ Experimental Workbench **1.30.164014.27**, and comparisons between supported legacy constructs and editor output. This tool is not based on a complete official file grammar. Original mod data, private editor artifacts and recordings are not public test fixtures.

A field comparison can establish preserved values and consistent references. It cannot prove correct root motion, identical blending, visible model animation or network/script behavior. Other editor builds and additional constructs require their own validation. See [format support](format-support.md) for the exact supported subset.

## What the commands establish

| Command | Meaning |
|---|---|
| `inspect` | The selected workspace and dependencies can be analyzed within the supported scope. No converted output is written. |
| `convert` | A new project copy containing supported converted resources was created. Source and output remain separate. |
| `verify` | The output passes manifest and resource-reference checks. This is not editor or gameplay acceptance. |
| `serve` | Starts the local interface for these file operations; it does not expand their conversion scope. |

Reports at `.animgraph-migration/report.json` and `.animgraph-migration/manifest.json` describe their generated file set. Later edits to tracked files can invalidate its integrity check. A matching manifest alone does not certify visible runtime behavior.

## Check your project in the editor

1. Back up the source and record the exact input file set. Choose a new output folder outside the source.
2. Run `inspect`, `convert` and `verify`. Retain reports and any errors.
3. Use a separate test copy of the output in the matching DayZ 1.30 Workbench. Mount matching game data and review absolute paths in copied `.gproj` files. Do not mount original and converted resources together where identities could collide.
4. Open the workspace and graph. Record exact messages, console logs, editor build and loading behavior.
5. Compare state machines, states, transitions, conditions, switch values and clip assignments with the source.
6. Compare assignment counts and resource identities before and after a native save. Reopen the saved result after restarting the editor.
7. Check the preview model, skeleton, bone names, materials and visible clip playback. A running timeline alone does not prove visible model animation.

Perform editor saves in the test copy so the converter output and manifest remain intact. The converter does not run Workbench imports or replace any separately required model or clip work.

## Isolated game test

After editor checks, load your mod in a separate test environment. Observe relevant states and transitions, loops, movement, root motion, scale, ground contact and script/bone queries. In a client/server test, confirm that both actually load the same intended package.

Record which sequences were observed, any deviations and conditions still untested. A successful short visual test establishes that run; it does not cover all transitions, long sessions, network conditions or other mods. If jitter occurs, distinguish animation movement, camera movement and overall frame-rate behavior in the evidence.

## Report a problem or request an extension

Include the application version, Node.js version, operating system, command and exact error. For an extension, provide a small artificial legacy input and the expected native structure. Remove personal paths and share only files you are allowed to publish.

Extensions need appropriate automated tests for value preservation, reference consistency and rejected ambiguities. Changes to target-format semantics also need evidence from the matching editor.
