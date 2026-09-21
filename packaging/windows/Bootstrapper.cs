using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

internal static class Bootstrapper
{
    // Silent mode (/S, /silent, /quiet or /verysilent) shows nothing and opens nothing,
    // as the Microsoft Store and managed deployments require: the outcome is the exit code,
    // and a failure is also written to %TEMP%\sap-mcp-bridge-install-error.log.
    private const int AlreadyRunning = 1618;
    private static bool silent;

    [STAThread]
    private static int Main(string[] args)
    {
        foreach (string arg in args)
        {
            string flag = arg.TrimStart('/', '-').ToLowerInvariant();
            if (flag == "s" || flag == "silent" || flag == "quiet" || flag == "verysilent") silent = true;
        }
        bool created;
        using (var mutex = new Mutex(true, "Local\\SapMcpDesktopBridgeInstaller", out created))
        {
            if (!created)
            {
                if (silent) return AlreadyRunning;
                MessageBox.Show("SAP MCP Desktop Bridge is already being installed. Please wait for the existing installer to finish.", "Installer already running", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 2;
            }
            return RunInstaller();
        }
    }

    private static void ReportFailure(string message)
    {
        if (!silent)
        {
            MessageBox.Show(message, "SAP MCP Desktop Bridge installation failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "sap-mcp-bridge-install-error.log"), DateTime.Now.ToString("s") + "  " + message + Environment.NewLine); } catch { }
    }

    private static string InstallDirectory()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "SAP MCP Desktop Bridge");
    }

    private static int RunInstaller()
    {
        string temp = Path.Combine(Path.GetTempPath(), "sap-mcp-bridge-" + Guid.NewGuid().ToString("N"));
        // Checked before installing, because by the time it finishes the directory exists
        // either way. It decides the wording only: the app is opened either way, since an
        // upgrade closes a running manager and should hand it back.
        bool firstInstall = !Directory.Exists(InstallDirectory());
        Form progress = null;
        try
        {
            Application.EnableVisualStyles();
            if (!silent) progress = new Form { Text = "SAP MCP Desktop Bridge", Width = 430, Height = 145, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ControlBox = false, ShowInTaskbar = true, TopMost = true };
            if (progress != null)
            {
                progress.Controls.Add(new Label { Text = "Installing SAP MCP Desktop Bridge…", AutoSize = true, Left = 24, Top = 22, Font = new System.Drawing.Font("Segoe UI", 11F) });
                progress.Controls.Add(new ProgressBar { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25, Left = 24, Top = 58, Width = 365, Height = 18 });
                progress.Show(); Application.DoEvents();
            }
            Directory.CreateDirectory(temp);
            Extract("payload.zip", Path.Combine(temp, "payload.zip"));
            Extract("Install.ps1", Path.Combine(temp, "Install.ps1"));
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            var start = new ProcessStartInfo {
                FileName = powershell,
                Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(temp, "Install.ps1") + "\" -Payload \"" + Path.Combine(temp, "payload.zip") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                WorkingDirectory = temp
            };
            using (var process = Process.Start(start))
            {
                while (!process.WaitForExit(100)) Application.DoEvents();
                string error = process.StandardError.ReadToEnd().Trim();
                if (progress != null) { progress.Close(); progress = null; }
                if (process.ExitCode != 0)
                {
                    ReportFailure(String.IsNullOrWhiteSpace(error) ? "Installation did not complete." : error);
                    return process.ExitCode;
                }
                // A silent install ends here: it neither announces itself nor opens the app.
                if (silent) return 0;
                MessageBox.Show(firstInstall
                    ? "SAP MCP Bridge successfully installed!\n\nOpening SAP MCP Connection Manager now. You can start it any time from the Windows Start menu."
                    : "SAP MCP Bridge successfully updated!\n\nOpen SAP MCP Connection Manager from the Windows Start menu when you are ready.",
                    "Installation complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Launch();
                return 0;
            }
        }
        catch (Exception error)
        {
            ReportFailure(error.Message);
            return 1;
        }
        finally
        {
            if (progress != null) progress.Close();
            try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { }
        }
    }

    private static void Launch()
    {
        // A window that will not open is not a failed installation: the app is installed
        // and reachable from the Start menu either way.
        try
        {
            string app = Path.Combine(InstallDirectory(), "desktop", "SAP MCP Connection Manager.exe");
            if (File.Exists(app)) Process.Start(new ProcessStartInfo { FileName = app, UseShellExecute = true });
        }
        catch { }
    }

    private static void Extract(string resource, string destination)
    {
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
        using (FileStream output = File.Create(destination))
        {
            if (input == null) throw new InvalidOperationException("Installer resource is missing: " + resource);
            input.CopyTo(output);
        }
    }
}
