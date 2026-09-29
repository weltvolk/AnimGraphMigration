# Format support

AnimGraphMigration 1.1 provides general graph conversion for an explicitly supported subset of legacy DayZ animation resources. Support depends on constructs and references, not the mod's identity. Compatibility with every mod is not claimed.

Output follows files examined with DayZ Experimental Workbench **1.30.164014.27**. This project does not implement a complete official file grammar. Unknown semantic fields and unsupported constructs cause an explicit error instead of being silently removed.

## Resources and references

- Select a workspace by its virtual path relative to the input root, such as `ExampleMod/anims/example.aw`.
- Virtual mod paths are preserved. Generated resources receive deterministic identities and consistent internal references.
- Workspace, graph and instance references must agree with the associated animation-set template. A different legacy workspace template reference requires inspection.
- Instance assignments and graph sources must use the same qualified `Group.Column.Animation` names.
- Direct graph, template, instance, clip and preview-model dependencies must exist inside the input root.
- Dependencies inside binary models or the engine are not resolved automatically. Matching game data remains a separate requirement.

The selected workspace determines the conversion scope. Other legacy files are copied without being converted. The command-line entry point expects a legacy workspace, graphs and instances; a known native template may be used. Resource modules can also read some native workspace and instance structures, but this does not make arbitrary native/legacy mixtures supported CLI input.

## File families

| Family | Output or treatment |
|---|---|
| Workspace | Native `.aw` with supported preview information preserved. |
| Graph definition | `AnimSrcGraph` in `.agr`, referencing the generated `.agf` files. |
| Graph contents | `AnimSrcGraphFile` with sheets, state machines, states and transitions. |
| Template | `AnimSetTemplateSource` with named groups, columns and animation slots. |
| Instance | `AnimSetInstanceSource` with a template reference and qualified clip assignments. |
| Metadata | Consistent resource identities for generated files. |
| Models, skeletons and clips | Copies of source files with no content conversion. |

## Templates, instances and workspace fields

| Input | Support |
|---|---|
| Legacy AST | Exactly one unnamed group type with `#ngroupnames 0`; declared counts are checked. Explicit group and column names are generated. |
| Named legacy groups or multiple legacy group types | Rejected. |
| Native AST | Known `Groups`/`Name`/`Animations`/`Columns` structure; multiple named groups and columns are supported when assignments are unambiguous. |
| Slot names | Empty names, dots within a component, duplicates and ambiguous unqualified names are rejected. |
| Legacy ASI | An independent instance with `#nparents 0`; resource assignments must map fully to template slots. |
| Native ASI in resource modules | No nonempty `ParentTemplates`; only supported resource assignments. Duplicate or unknown slots are rejected. The CLI expects legacy instances. |
| Workspace | Supported template, instance, graph and preview-model references are rewritten together. An existing EventTable reference is retained. |
| Preview metadata | Supported model references and object identities are retained. Unknown extra fields or transforms are rejected. |
| Additional workspace tests | Nonempty `AttachmentTesting` or `IkTesting` structures are rejected. |

Unlisted fields carry no promise of support. The explicit mapping in the code is authoritative; unexpected data must fail visibly.

Resource paths cannot contain control characters. Quoted strings use escapes; an ambiguous single backslash before `n`, `r` or `t` in a legacy path is rejected after parsing. Forward slashes are the unambiguous spelling for virtual resource paths.

## Graph constructs

The implemented grammar is the supported subset of **`$AnimGraph 7`**. Conditions and other expressions are transferred as strings, not executed.

| Legacy construct | Support and mapping |
|---|---|
| Sheets | Named sheets with checked node references. |
| `AnimNodeStateMachine` | States, child nodes, start conditions and transitions. Nested structures use node references. |
| State time mode | `realtime` → `Real Time`; `notime` → `Inherit`. Other modes are rejected. |
| State exit flag | `0` or `1`. |
| Transition | Source/target state, duration, start time and condition preserved; `PostEval` only `0` or `1`. An empty legacy source state produces a global transition without `FromState`, as observed in the editor; a target remains required. |
| Transition blending | Only the observed legacy value `S`; `MotionVecBlend` is emitted as `0x33 0`, matching the examined native migration. |
| `AnimNodeSource` | Source name; `loop` → `Loop`; `noloop` → `No Loop`; a legacy tag string becomes a tags list. |
| Other tags | Nonempty tags on states, state machines or switches are rejected because their mapping has not been established. |
| Source predictions | Empty only. |
| `AnimNodeSwitch` | Header values `0 0.0` only; empty or fully indexed percentage distributions summing to 100. The first probability list must be empty. |
| Editor position | Y coordinate is inverted for the new layout. A missing position becomes `0 0` with a warning. |
| Control variables | `float` and `int`, with an empty legacy annotation, default, minimum and maximum. |
| Commands | Legacy flag `-1` maps to the observed `Synchronized 1`. |
| Control expressions | Empty list only. |
| Debug controls | Supported `#DCtrl 2` command controls without a named group. |

Declared counts, duplicate IDs and unresolved internal references are checked. Additional node types, other modes or flags, nonempty predictions or expressions, unknown blend values and unsupported control types cause an error.

Layout data affects the editor view. Replacing a layout value does not prove identical runtime behavior. The observed `MotionVecBlend` serialization is evidence for the examined case, not a general statement about every blending scenario.

## Limits

- No general support for every DayZ, Enfusion or Arma Reforger format.
- No PBO extraction or packaging, and no Workshop upload.
- No model, skeleton, XOB, P3D or texture import.
- No TXA transformation, ANM generation or content validation of copied movement clips.
- No automated or headless Workbench import.
- No automatic repair of camera, script, material, scale or bone issues.
- No automatic gameplay approval after file or integrity checks.
- No silent interpretation of unknown nodes, events, sync tables or other unimplemented structures.

A mod without its own AnimGraph is outside this conversion workflow. Script-driven `AnimationSources` and bone APIs require separate tests. Copied models and clips need runtime compatibility checks even when their graph is supported.

## Extensions and project checks

Use a small artificial legacy input and expected target structure when proposing new constructs. Keep original mod and game data out of the repository. Tests should cover value preservation, reference consistency, rejected ambiguities and reproducible output. Changes to target-format semantics also require separate evidence from the matching editor.

See the [validation guide](validation.md) for editor and game checks of your own mod.
