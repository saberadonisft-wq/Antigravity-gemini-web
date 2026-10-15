using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AntigravityShim
{
    class Program
    {
        // Windows Job Object interop for reliable process tree lifecycle
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

        const int STD_OUTPUT_HANDLE = -11;
        const int STD_ERROR_HANDLE = -12;

        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryLimit;
            public UIntPtr PeakJobMemoryLimit;
        }

        static IntPtr hJob = IntPtr.Zero;
        static volatile bool s_forwardingFailed = false;

        static bool SetupJobObject(out string errorReason)
        {
            errorReason = null;
            if (Environment.GetEnvironmentVariable("ANTIGRAVITY_SIMULATE_JOB_FAIL") == "1")
            {
                errorReason = "Simulated Job Object creation failure for S4 test";
                return false;
            }

            try
            {
                hJob = CreateJobObject(IntPtr.Zero, null);
                if (hJob == IntPtr.Zero)
                {
                    int win32Err = Marshal.GetLastWin32Error();
                    errorReason = string.Format("CreateJobObject failed with Win32 error {0}", win32Err);
                    return false;
                }

                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr pInfo = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(info, pInfo, false);
                    bool ok = SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, pInfo, length);
                    if (!ok)
                    {
                        int win32Err = Marshal.GetLastWin32Error();
                        errorReason = string.Format("SetInformationJobObject failed with Win32 error {0}", win32Err);
                        CloseHandle(hJob);
                        hJob = IntPtr.Zero;
                        return false;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pInfo);
                }

                return true;
            }
            catch (Exception ex)
            {
                errorReason = ex.Message;
                if (hJob != IntPtr.Zero)
                {
                    CloseHandle(hJob);
                    hJob = IntPtr.Zero;
                }
                return false;
            }
        }

        // Canonical Windows CommandLine argument quoting conforming strictly to CommandLineToArgvW rules [S1]
        public static string QuoteArgument(string arg)
        {
            if (arg == null || arg.Length == 0)
            {
                return "\"\"";
            }

            bool needsQuotes = false;
            for (int i = 0; i < arg.Length; i++)
            {
                char c = arg[i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\"')
                {
                    needsQuotes = true;
                    break;
                }
            }

            if (!needsQuotes)
            {
                return arg;
            }

            var sb = new StringBuilder();
            sb.Append('\"');
            int backslashCount = 0;
            for (int i = 0; i < arg.Length; i++)
            {
                char c = arg[i];
                if (c == '\\')
                {
                    backslashCount++;
                }
                else if (c == '\"')
                {
                    // 2 * backslashCount + 1 backslashes followed by quote
                    sb.Append('\\', backslashCount * 2 + 1);
                    sb.Append('\"');
                    backslashCount = 0;
                }
                else
                {
                    if (backslashCount > 0)
                    {
                        sb.Append('\\', backslashCount);
                        backslashCount = 0;
                    }
                    sb.Append(c);
                }
            }

            // Trailing backslashes before closing quote must be doubled: 2 * backslashCount
            if (backslashCount > 0)
            {
                sb.Append('\\', backslashCount * 2);
            }
            sb.Append('\"');
            return sb.ToString();
        }

        const int ERR_JOB_OBJECT_FAILED = 124;
        const int ERR_DRAIN_TIMEOUT = 125;
        const int ERR_TARGET_LAUNCH_FAILED = 126;
        const int ERR_TARGET_NOT_FOUND = 127;
        const int ERR_PIPE_FORWARDING_FAILED = 128;

        static bool IsSensitiveKeyName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string lower = name.ToLowerInvariant();
            return lower.Contains("csrf") ||
                   lower.Contains("token") ||
                   lower.Contains("secret") ||
                   lower.Contains("key") ||
                   lower.Contains("password") ||
                   lower.Contains("auth") ||
                   lower.Contains("bearer") ||
                   lower.Contains("credential");
        }

        static bool IsUrlFlag(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string n = name.TrimStart('-');
            return string.Equals(n, "cloud_code_endpoint", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "generative_service_addr", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "inference_api_server_url", StringComparison.OrdinalIgnoreCase);
        }

        static bool IsNumericFlag(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string n = name.TrimStart('-');
            return string.Equals(n, "extension_server_port", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "https_server_port", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "http_server_port", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "parent_pid", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "delay_ms", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "byte_count", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "chunk_delay_ms", StringComparison.OrdinalIgnoreCase);
        }

        static bool IsIdentifierFlag(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string n = name.TrimStart('-');
            return string.Equals(n, "model_api_client_type", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "scenario", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "ide_name", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "ide_version", StringComparison.OrdinalIgnoreCase);
        }

        static bool IsStandaloneFlag(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string n = name.TrimStart('-');
            return string.Equals(n, "random_port", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "verbose", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "v", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "help", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "h", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(n, "version", StringComparison.OrdinalIgnoreCase);
        }

        static string SanitizeUrl(string rawUrl)
        {
            if (string.IsNullOrEmpty(rawUrl)) return "[REDACTED]";
            try
            {
                if (!rawUrl.Contains("://"))
                {
                    string cleaned = rawUrl;
                    int qIdx = cleaned.IndexOf('?');
                    if (qIdx >= 0) cleaned = cleaned.Substring(0, qIdx);
                    int fIdx = cleaned.IndexOf('#');
                    if (fIdx >= 0) cleaned = cleaned.Substring(0, fIdx);
                    int atIdx = cleaned.IndexOf('@');
                    if (atIdx >= 0)
                    {
                        int colonIdx = cleaned.IndexOf(':');
                        if (colonIdx >= 0 && colonIdx < atIdx)
                            cleaned = cleaned.Substring(0, colonIdx + 1) + cleaned.Substring(atIdx + 1);
                        else
                            cleaned = cleaned.Substring(atIdx + 1);
                    }
                    return cleaned;
                }

                Uri uri;
                if (Uri.TryCreate(rawUrl, UriKind.Absolute, out uri))
                {
                    string portPart = uri.IsDefaultPort ? "" : ":" + uri.Port;
                    string pathPart = uri.AbsolutePath;
                    if (string.IsNullOrEmpty(pathPart)) pathPart = "/";
                    return uri.Scheme + "://" + uri.Host + portPart + pathPart;
                }
            }
            catch { }

            return "[REDACTED]";
        }

        static bool IsSafeIdentifier(string val)
        {
            if (string.IsNullOrEmpty(val)) return false;
            foreach (char c in val)
            {
                if (!char.IsLetterOrDigit(c) && c != '_' && c != '-' && c != '.')
                    return false;
            }
            return true;
        }

        static bool IsNumeric(string val)
        {
            if (string.IsNullOrEmpty(val)) return false;
            long num;
            return long.TryParse(val, out num);
        }

        enum ExpectedValueKind
        {
            None,
            Sensitive,
            Url,
            Numeric,
            Identifier,
            Unknown
        }

        // Metadata allowlist: scrubs query/userinfo/fragments, validates numbers/enums, masks unknown flags and positional args [H1]
        static string SanitizeArgumentsForLogging(string[] args)
        {
            var sb = new StringBuilder();
            ExpectedValueKind expectedValue = ExpectedValueKind.None;

            for (int i = 0; i < args.Length; i++)
            {
                string token = args[i];
                if (sb.Length > 0) sb.Append(" ");

                if (expectedValue != ExpectedValueKind.None)
                {
                    switch (expectedValue)
                    {
                        case ExpectedValueKind.Sensitive:
                            sb.Append("[REDACTED]");
                            break;
                        case ExpectedValueKind.Url:
                            sb.Append(SanitizeUrl(token));
                            break;
                        case ExpectedValueKind.Numeric:
                            sb.Append(IsNumeric(token) ? token : "[REDACTED]");
                            break;
                        case ExpectedValueKind.Identifier:
                            sb.Append(IsSafeIdentifier(token) ? token : "[REDACTED]");
                            break;
                        case ExpectedValueKind.Unknown:
                        default:
                            sb.Append("[REDACTED]");
                            break;
                    }
                    expectedValue = ExpectedValueKind.None;
                    continue;
                }

                int eqIdx = token.IndexOf('=');
                if (eqIdx >= 0)
                {
                    string keyPart = token.Substring(0, eqIdx);
                    string valPart = token.Substring(eqIdx + 1);

                    if (IsSensitiveKeyName(keyPart))
                    {
                        sb.Append(keyPart).Append("=[REDACTED]");
                    }
                    else if (IsUrlFlag(keyPart))
                    {
                        sb.Append(keyPart).Append("=").Append(SanitizeUrl(valPart));
                    }
                    else if (IsNumericFlag(keyPart))
                    {
                        sb.Append(keyPart).Append("=").Append(IsNumeric(valPart) ? valPart : "[REDACTED]");
                    }
                    else if (IsIdentifierFlag(keyPart))
                    {
                        sb.Append(keyPart).Append("=").Append(IsSafeIdentifier(valPart) ? valPart : "[REDACTED]");
                    }
                    else
                    {
                        sb.Append(keyPart).Append("=[REDACTED]");
                    }
                }
                else if (token.StartsWith("-"))
                {
                    if (IsSensitiveKeyName(token))
                    {
                        sb.Append(token);
                        expectedValue = ExpectedValueKind.Sensitive;
                    }
                    else if (IsUrlFlag(token))
                    {
                        sb.Append(token);
                        expectedValue = ExpectedValueKind.Url;
                    }
                    else if (IsNumericFlag(token))
                    {
                        sb.Append(token);
                        expectedValue = ExpectedValueKind.Numeric;
                    }
                    else if (IsIdentifierFlag(token))
                    {
                        sb.Append(token);
                        expectedValue = ExpectedValueKind.Identifier;
                    }
                    else if (IsStandaloneFlag(token))
                    {
                        sb.Append(token);
                        expectedValue = ExpectedValueKind.None;
                    }
                    else
                    {
                        sb.Append(token);
                        expectedValue = ExpectedValueKind.Unknown;
                    }
                }
                else
                {
                    sb.Append("[ARG]");
                }
            }

            return sb.ToString();
        }

        static void Log(string message)
        {
            try
            {
                string logPath = Environment.GetEnvironmentVariable("ANTIGRAVITY_SHIM_LOG_PATH");
                if (string.IsNullOrEmpty(logPath))
                {
                    string dir = AppDomain.CurrentDomain.BaseDirectory;
                    logPath = Path.Combine(dir, "shim.log");
                }
                string timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
                File.AppendAllText(logPath, string.Format("[{0}] [PID:{1}] {2}{3}", timestamp, Process.GetCurrentProcess().Id, message, Environment.NewLine));
            }
            catch
            {
                // Logging failures must not crash forwarding
            }
        }

        static int Main(string[] args)
        {
            // 1. Setup Job Object with fail-closed guarantee [S4]
            string jobErr;
            if (!SetupJobObject(out jobErr))
            {
                string msg = "FATAL: Windows Job Object setup failed: " + jobErr;
                Log(msg);
                Console.Error.WriteLine(msg);
                return 124; // Job Object init failure code
            }

            try
            {
                string defaultTarget = @"D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe";
                string targetPath = Environment.GetEnvironmentVariable("ANTIGRAVITY_TARGET_LS_PATH");
                if (string.IsNullOrEmpty(targetPath))
                {
                    targetPath = defaultTarget;
                }

                // Log metadata with strict redaction [S2]
                Log(string.Format("Antigravity transparent shim invoked. Target: '{0}'. Args: '{1}'. Cwd: '{2}'",
                    targetPath, SanitizeArgumentsForLogging(args), Environment.CurrentDirectory));

                if (!File.Exists(targetPath))
                {
                    string err = string.Format("Target binary does not exist at: {0}", targetPath);
                    Log(err);
                    Console.Error.WriteLine(err);
                    return 127;
                }

                // 2. Reconstruct arguments using canonical Win32 rules [S1]
                var argBuilder = new StringBuilder();
                foreach (var arg in args)
                {
                    if (argBuilder.Length > 0) argBuilder.Append(" ");
                    argBuilder.Append(QuoteArgument(arg));
                }

                var psi = new ProcessStartInfo();
                psi.FileName = targetPath;
                psi.WorkingDirectory = Environment.CurrentDirectory;
                psi.Arguments = argBuilder.ToString();
                psi.UseShellExecute = false;
                psi.RedirectStandardInput = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;

                Process child = null;
                try
                {
                    child = Process.Start(psi);
                }
                catch (Exception ex)
                {
                    Log(string.Format("Failed to spawn target process '{0}': {1}", targetPath, ex.Message));
                    Console.Error.WriteLine("Failed to spawn target: " + ex.Message);
                    return 126;
                }

                // 3. Assign child to Job Object immediately and fail-closed if assignment fails [S4]
                if (hJob != IntPtr.Zero && child != null)
                {
                    bool assigned = AssignProcessToJobObject(hJob, child.Handle);
                    if (!assigned)
                    {
                        int win32Err = Marshal.GetLastWin32Error();
                        string assignErr = string.Format("FATAL: Failed to assign child process PID {0} to Job Object (Win32 error {1})", child.Id, win32Err);
                        Log(assignErr);
                        Console.Error.WriteLine(assignErr);
                        try { child.Kill(); } catch { }
                        return 124;
                    }
                }

                Log(string.Format("Target process spawned successfully with PID: {0}", child.Id));

                // 4. Stream STDIN asynchronously
                var stdinThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream input = Console.OpenStandardInput())
                        using (Stream output = child.StandardInput.BaseStream)
                        {
                            byte[] buffer = new byte[8192];
                            int bytesRead;
                            while ((bytesRead = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                output.Write(buffer, 0, bytesRead);
                                output.Flush();
                            }
                        }
                    }
                    catch
                    {
                        // Stdin EOF or pipe closed
                    }
                    finally
                    {
                        try { child.StandardInput.Close(); } catch { }
                    }
                });
                stdinThread.IsBackground = true;
                stdinThread.Start();

                // 5. Stream STDOUT asynchronously with drain completion tracking [S3, H2]
                s_forwardingFailed = false;
                Exception stdoutEx = null;
                IntPtr hStdout = GetStdHandle(STD_OUTPUT_HANDLE);
                var stdoutThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream input = child.StandardOutput.BaseStream)
                        {
                            byte[] buffer = new byte[8192];
                            int bytesRead;
                            while ((bytesRead = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                int bytesWritten;
                                bool ok = WriteFile(hStdout, buffer, bytesRead, out bytesWritten, IntPtr.Zero);
                                if (!ok || bytesWritten < bytesRead)
                                {
                                    int win32Err = Marshal.GetLastWin32Error();
                                    s_forwardingFailed = true;
                                    stdoutEx = new IOException(string.Format("WriteFile to stdout failed with Win32 error {0}", win32Err));
                                    Log("FATAL: Stdout write to parent failed: " + stdoutEx.Message);
                                    try { if (!child.HasExited) child.Kill(); } catch { }
                                    break;
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        s_forwardingFailed = true;
                        stdoutEx = ex;
                        Log("FATAL: Stdout read from child failed: " + ex.Message);
                        try { if (!child.HasExited) child.Kill(); } catch { }
                    }
                });
                stdoutThread.IsBackground = true;
                stdoutThread.Start();

                // 6. Stream STDERR asynchronously with drain completion tracking [S3, H2]
                Exception stderrEx = null;
                IntPtr hStderr = GetStdHandle(STD_ERROR_HANDLE);
                var stderrThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream input = child.StandardError.BaseStream)
                        {
                            byte[] buffer = new byte[8192];
                            int bytesRead;
                            while ((bytesRead = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                int bytesWritten;
                                bool ok = WriteFile(hStderr, buffer, bytesRead, out bytesWritten, IntPtr.Zero);
                                if (!ok || bytesWritten < bytesRead)
                                {
                                    int win32Err = Marshal.GetLastWin32Error();
                                    s_forwardingFailed = true;
                                    stderrEx = new IOException(string.Format("WriteFile to stderr failed with Win32 error {0}", win32Err));
                                    Log("FATAL: Stderr write to parent failed: " + stderrEx.Message);
                                    try { if (!child.HasExited) child.Kill(); } catch { }
                                    break;
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        s_forwardingFailed = true;
                        stderrEx = ex;
                        Log("FATAL: Stderr read from child failed: " + ex.Message);
                        try { if (!child.HasExited) child.Kill(); } catch { }
                    }
                });
                stderrThread.IsBackground = true;
                stderrThread.Start();

                // Handle cancellation / graceful exit
                Console.CancelKeyPress += (s, e) =>
                {
                    Log("Cancel key pressed (SIGINT/Ctrl+C). Terminating child process.");
                    e.Cancel = true;
                    try
                    {
                        if (child != null && !child.HasExited)
                        {
                            child.Kill();
                        }
                    }
                    catch { }
                };

                // Wait for target process exit or early forwarding failure [H2]
                while (!child.HasExited)
                {
                    if (s_forwardingFailed)
                    {
                        Log("Forwarding pipe failure detected while child was running. Ensuring child is terminated.");
                        try { if (!child.HasExited) child.Kill(); } catch { }
                        break;
                    }
                    if (child.WaitForExit(100))
                    {
                        break;
                    }
                }

                // 7. Ensure output workers fully drain EOF with reasonable deadline (15 seconds) [S3]
                bool stdoutDrained = stdoutThread.Join(15000);
                bool stderrDrained = stderrThread.Join(15000);

                if (!stdoutDrained || !stderrDrained)
                {
                    string drainWarn = string.Format("WARNING: Output drain timed out after 15000ms. stdoutDrained: {0}, stderrDrained: {1}", stdoutDrained, stderrDrained);
                    Log(drainWarn);
                    Console.Error.WriteLine(drainWarn);
                    return ERR_DRAIN_TIMEOUT; // 125
                }

                if (s_forwardingFailed || stdoutEx != null || stderrEx != null)
                {
                    string pipeFailMsg = string.Format("FATAL: Forwarding pipe error (bytes lost). stdoutEx: {0}, stderrEx: {1}. Exiting with code {2}",
                        stdoutEx != null ? stdoutEx.Message : "none",
                        stderrEx != null ? stderrEx.Message : "none",
                        ERR_PIPE_FORWARDING_FAILED);
                    Log(pipeFailMsg);
                    return ERR_PIPE_FORWARDING_FAILED; // 128
                }

                int exitCode = child.ExitCode;
                Log(string.Format("Target process {0} exited cleanly with code: {1}", child.Id, exitCode));
                return exitCode;
            }
            finally
            {
                // Cleanup Job Object handle [S4]
                if (hJob != IntPtr.Zero)
                {
                    CloseHandle(hJob);
                    hJob = IntPtr.Zero;
                }
            }
        }
    }
}
