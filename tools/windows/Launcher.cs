// MIT. Native WinForms/WebView2 host; compile as x64 winexe.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            foreach (string file in new[] { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "runtime/node/node.exe", "app/bin/animgraph-migration-general.mjs" })
                if (!File.Exists(Path.Combine(root, file))) throw new FileNotFoundException("Extract the entire ZIP to a writable folder before starting AnimGraphMigration.exe. Missing: " + file);
            foreach (string name in new[] { "NODE_OPTIONS", "NODE_PATH", "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", "WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS" }) Environment.SetEnvironmentVariable(name, null);
            RunDesktop(root);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "AnimGraphMigration - startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // Keep WebView2 type resolution behind the plain-file preflight and Main's exception handler.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunDesktop(string root) { Application.Run(new DesktopWindow(root)); }
}

internal sealed class DesktopWindow : Form
{
    private const string RuntimeDownload = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";
    private readonly string root;
    private readonly Label status;
    private readonly OwnedNode node = new OwnedNode();
    private WebView2 view;
    private bool closing;

    internal DesktopWindow(string folder)
    {
        root = folder;
        Text = "AnimGraphMigration";
        MinimumSize = new Size(800, 650);
        Size = new Size(1080, 900);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 22, 19);
        ForeColor = Color.FromArgb(228, 237, 225);
        status = new Label { Dock = DockStyle.Fill, Text = "Starting AnimGraphMigration...", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12), Padding = new Padding(28) };
        Controls.Add(status);
        Shown += async delegate { await StartAsync(); };
        FormClosed += delegate { closing = true; if (view != null) view.Dispose(); node.Dispose(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { node.Dispose(); };
    }

    private async Task StartAsync()
    {
        try
        {
            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException) { MissingRuntime(); return; }
            string data = Path.Combine(root, "data", "WebView2");
            try
            {
                Directory.CreateDirectory(data);
                string probe = Path.Combine(data, ".write-check-" + Guid.NewGuid().ToString("N"));
                using (FileStream file = new FileStream(probe, FileMode.CreateNew, FileAccess.Write)) { }
                File.Delete(probe);
            }
            catch (Exception error) { throw new IOException("The portable data folder is not writable. Extract the ZIP to a writable folder and try again. " + error.Message); }
            node.Start(root);
            Task<string> ready = node.ReadSessionUrlAsync();
            if (await Task.WhenAny(ready, Task.Delay(20000)) != ready) throw new TimeoutException("The local service did not become ready within 20 seconds.");
            string url = await ready;
            if (closing) return;
            Uri origin = new Uri(url);
            view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            view.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = data, Language = "en-US", IsInPrivateModeEnabled = true };
            Controls.Add(view);
            await view.EnsureCoreWebView2Async();
            if (closing) return;
            view.CoreWebView2.Settings.AreDevToolsEnabled = false;
            view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args)
            {
                Uri target;
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out target) || target.Scheme != origin.Scheme || target.Host != origin.Host || target.Port != origin.Port) args.Cancel = true;
            };
            view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) { args.Handled = true; };
            view.CoreWebView2.Navigate(url);
            status.Visible = false;
            view.BringToFront();
            await node.WaitForExitAsync();
            if (!closing) ShowError("The local service stopped. Close this window and start AnimGraphMigration again.");
        }
        catch (Exception error) { if (!closing) ShowError(error.Message); }
    }

    private void MissingRuntime()
    {
        status.Text = "Microsoft Edge WebView2 Runtime is required for this application window.\n\nInstall the Evergreen Runtime from Microsoft's official page, then start the program again.";
        LinkLabel download = new LinkLabel { Text = "Open Microsoft's WebView2 download page", AutoSize = false, Dock = DockStyle.Bottom, Height = 72, TextAlign = ContentAlignment.MiddleCenter, LinkColor = Color.FromArgb(157, 211, 173) };
        download.LinkClicked += delegate { try { Process.Start(new ProcessStartInfo(RuntimeDownload) { UseShellExecute = true }); } catch (Exception error) { MessageBox.Show(error.Message, "Download page could not be opened"); } };
        Controls.Add(download);
    }

    private void ShowError(string message)
    {
        node.Dispose();
        if (view != null) { view.Dispose(); view = null; }
        status.Text = "AnimGraphMigration could not start.\n\n" + message;
        status.Visible = true;
        status.BringToFront();
    }
}

internal sealed class OwnedNode : IDisposable
{
    private readonly object gate = new object();
    private IntPtr job, process;
    private AnonymousPipeServerStream pipe;
    private StreamReader reader;
    private Task outputDrain;
    private bool disposed;

    internal void Start(string root)
    {
        lock (gate)
        {
            if (disposed) throw new ObjectDisposedException("OwnedNode");
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Error("Could not create the local-service lifetime guard");
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.LimitFlags = 0x00002000;
            int size = Marshal.SizeOf(typeof(ExtendedLimits)); IntPtr memory = Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(limits, memory, false); if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw Error("Could not activate the local-service lifetime guard"); }
            finally { Marshal.FreeHGlobal(memory); }
            pipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
            IntPtr input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            if (input == new IntPtr(-1)) throw Error("Could not initialize the hidden service input");
            ProcessInformation child = new ProcessInformation(); bool assigned = false;
            try
            {
                StartupInfo startup = new StartupInfo { cb = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x00000100, StdInput = input, StdOutput = pipe.ClientSafePipeHandle.DangerousGetHandle(), StdError = pipe.ClientSafePipeHandle.DangerousGetHandle() };
                string executable = Path.Combine(root, "runtime", "node", "node.exe");
                string entry = Path.Combine(root, "app", "bin", "animgraph-migration-general.mjs");
                StringBuilder command = new StringBuilder(Quote(executable) + " " + Quote(entry) + " serve");
                // Explicit pipe inheritance; suspended startup prevents Node running before job assignment.
                if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, root, ref startup, out child)) throw Error("Could not start the bundled Node runtime");
                if (!AssignProcessToJobObject(job, child.Process)) throw Error("Could not attach the local service to its lifetime guard");
                assigned = true; process = child.Process;
                if (ResumeThread(child.Thread) == 0xffffffff) throw Error("Could not resume the bundled Node runtime");
            }
            finally
            {
                CloseHandle(input);
                pipe.DisposeLocalCopyOfClientHandle();
                if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                if (!assigned && child.Process != IntPtr.Zero) { TerminateProcess(child.Process, 1); CloseHandle(child.Process); }
            }
            reader = new StreamReader(pipe, new UTF8Encoding(false));
        }
    }

    internal async Task<string> ReadSessionUrlAsync()
    {
        int lines = 0;
        while (lines++ < 100)
        {
            string line = await reader.ReadLineAsync();
            if (line == null) throw new IOException("The bundled service stopped before announcing its local address.");
            // Authentication URL stays in memory; no session/token file is written.
            if (Regex.IsMatch(line, @"^http://127\.0\.0\.1:[0-9]{1,5}/#[a-f0-9]{64}$"))
            {
                outputDrain = DrainOutputAsync();
                return line;
            }
        }
        throw new IOException("The service did not return a valid local session address.");
    }

    private async Task DrainOutputAsync() { try { while (await reader.ReadLineAsync() != null) { } } catch (ObjectDisposedException) { } catch (IOException) { } }
    internal Task WaitForExitAsync()
    {
        IntPtr copy;
        lock (gate)
        {
            if (disposed) return Task.FromResult(0);
            IntPtr self = GetCurrentProcess();
            if (!DuplicateHandle(self, process, self, out copy, 0, false, 2)) throw Error("Could not observe the local-service lifetime");
        }
        return Task.Run(delegate { try { WaitForSingleObject(copy, 0xffffffff); } finally { CloseHandle(copy); } });
    }
    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return; disposed = true;
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (process != IntPtr.Zero) { WaitForSingleObject(process, 3000); CloseHandle(process); process = IntPtr.Zero; }
            if (reader != null) reader.Dispose(); else if (pipe != null) pipe.Dispose();
            GC.KeepAlive(outputDrain);
        }
    }

    private static string Quote(string value) { if (value.IndexOf('"') >= 0) throw new ArgumentException("Invalid application path"); return "\"" + value + "\""; }
    private static Exception Error(string context) { int code = Marshal.GetLastWin32Error(); return new Win32Exception(code, context + " (Windows " + code + ")"); }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo { public uint cb; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort ShowWindow, ReservedCount; public IntPtr ReservedBytes, StdInput, StdOutput, StdError; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string fileName, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
}
