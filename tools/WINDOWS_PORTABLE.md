# Building the Windows portable application

The Windows x64 package opens its own **WinForms/WebView2 desktop window**. It runs the bundled Node.js service hidden, without opening an external browser or console. Closing the window terminates that service.

The builder creates the general graph-converter package from an explicit file list. It does not download dependencies or install npm packages. Run it on Windows, with output outside the source repository and runtime/SDK input directories.

## Build inputs

| Input | Required contents |
|---|---|
| `--runtime DIR` | Authentic Windows x64 `node.exe`, version 22 or newer, and its matching complete `LICENSE`. |
| `--webview2-sdk DIR` | `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, x64 `WebView2Loader.dll`, `LICENSE.txt` and `NOTICE.txt`, all directly inside this directory. |
| `--output NEW.zip` | A new ZIP path with an existing parent directory. Existing files are never overwritten. |
| Windows build tools | Windows PowerShell, the built-in .NET ZIP library and the x64 .NET Framework C# compiler. |

The reviewed WebView2 SDK is **1.0.4258.31**. Its official NuGet package contains Core and WinForms assemblies under `lib/net462/`; the WinForms assembly declares `.NETFramework,Version=v4.6.2`. Use the loader from the package's x64 native directory. Copy these files into the SDK input directory and retain the original license and notices. The `.nuspec` identifies the SDK version; it does not itself declare this managed framework target.

The builder checks supplied file structure and consistency, not upstream authenticity. Obtain Node.js and the SDK from their official distributions and verify their provenance separately. A different SDK requires a new compatibility check.

## Build command

From the repository, using Node.js 22 or newer:

```powershell
node tools/build-windows-portable.mjs --runtime "H:\BuildInputs\node" --webview2-sdk "H:\BuildInputs\webview2-sdk-1.0.4258.31" --output "H:\Releases\AnimGraphMigration-1.1.0-Windows-x64.zip"
```

These are example paths. The output folder must already exist. Runtime and SDK input files must remain unchanged throughout packaging. Links, junctions and redirected source paths are rejected.

The builder compiles `tools/windows/Launcher.cs` as UTF-8 with the x64 C# compiler at `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. It uses `/target:winexe`, `/platform:x64`, optimization, warnings as errors, and references to Windows Forms, Drawing and the supplied WebView2 Core/WinForms assemblies.

Compilation and staging occur in a new temporary directory beside the intended output ZIP. The launcher must be an AMD64 PE32+ executable using the Windows GUI subsystem. The compiler directory's historical version name does not mean the application supports an unmodified .NET Framework 4.0 installation.

## User requirements and layout

Users need **Windows x64, .NET Framework 4.6.2 or newer and Microsoft Edge WebView2 Evergreen Runtime**, plus an operating system supported by the bundled Node.js version. The SDK libraries are included; the Evergreen browser runtime is not. If that runtime is missing, the application shows an English explanation and a clickable Microsoft download link. It does not install it automatically.

Extract the entire archive into a writable folder and double-click `AnimGraphMigration.exe`. Keep all extracted files together. No separate Node.js installation or PATH change is needed. There is no CMD fallback in this package.

| Location | Contents |
|---|---|
| `AnimGraphMigration.exe` | Native desktop host. |
| Three WebView2 DLLs at the ZIP root | Managed Core/WinForms assemblies and the x64 native loader. |
| `app/` | General converter, English/German READMEs, documentation, desktop screenshot and assets. |
| `runtime/node/` | Bundled `node.exe` and its complete upstream `LICENSE`. |
| `runtime/webview2/` | SDK `LICENSE.txt` and `NOTICE.txt`. |
| `PORTABLE.txt` | Start instructions and dependency/license information. |
| `PORTABLE-MANIFEST.json` | File sizes, SHA-256 hashes and build/runtime details. |
| `data/WebView2/` | Writable browser-data location created on first launch; not shipped with user data. |

English is the initial interface language. German and Czech can be selected while the application is open. The host uses a private WebView2 session; language persistence between desktop launches is not promised.

The launcher starts Node suspended, assigns it to a Windows job with termination on handle close, and resumes it without a console. It reads the local authentication URL through an anonymous pipe in memory and creates no session-token file. External navigation and new browser windows are blocked in the embedded view. The host starts the general CLI's `serve` command without `--open`.

## Verification and package scope

The builder checks the Node executable's PE32+/AMD64 format, reported Windows/x64 platform and version; matching application versions; the launcher's GUI subsystem; and every compressed entry's size and SHA-256 hash. Application sources, launcher source, SDK files and runtime inputs are checked for changes before the final copy. The final ZIP must match the verified temporary archive.

The packaged `app/package.json` is generated with its binary, `start` and `gui` entries pointing only to `bin/animgraph-migration-general.mjs`. Source repository metadata remains unchanged. The manifest hashes the generated metadata actually shipped.

Only allowlisted general application files and required runtime/SDK files enter the ZIP. Private evidence, test fixtures, caches, repository history, game binaries and mod assets are excluded. Specialized clip/model migration is outside this portable edition.

ZIP creation uses Windows PowerShell and the built-in .NET ZIP library. After entry verification, the archive is copied with exclusive-create semantics, protecting a concurrently created destination. Temporary cleanup is restricted to the exact directory created for this build after checking its location. A cleanup failure retains that directory and reports its path.

## Licenses and source control

`app/LICENSE` covers the application. `runtime/node/LICENSE` retains Node.js licensing and bundled third-party notices. `runtime/webview2/LICENSE.txt` and `runtime/webview2/NOTICE.txt` retain the SDK terms and notices.

Keep runtime binaries, SDK packages, build output and release ZIPs outside the source repository. Packaging checks establish file consistency; they do not replace a native desktop launch/close smoke test or editor/game checks of converted projects.
