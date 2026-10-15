using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace FakeChild
{
    class Program
    {
        static string ToJsonArray(string[] items)
        {
            var sb = new StringBuilder();
            sb.Append("[");
            for (int i = 0; i < items.Length; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append("\"");
                foreach (char c in items[i])
                {
                    if (c == '\"') sb.Append("\\\"");
                    else if (c == '\\') sb.Append("\\\\");
                    else if (c == '\b') sb.Append("\\b");
                    else if (c == '\f') sb.Append("\\f");
                    else if (c == '\n') sb.Append("\\n");
                    else if (c == '\r') sb.Append("\\r");
                    else if (c == '\t') sb.Append("\\t");
                    else if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                    else sb.Append(c);
                }
                sb.Append("\"");
            }
            sb.Append("]");
            return sb.ToString();
        }

        static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
                Console.InputEncoding = Encoding.UTF8;
            }
            catch { }

            string scenario = "echo";
            int delayMs = 0;
            int byteCount = 12000;
            int chunkDelayMs = 10;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--scenario" && i + 1 < args.Length)
                {
                    scenario = args[i + 1];
                }
                else if (args[i] == "--delay_ms" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out delayMs);
                }
                else if (args[i] == "--byte_count" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out byteCount);
                }
                else if (args[i] == "--chunk_delay_ms" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out chunkDelayMs);
                }
            }

            if (scenario != "burst")
            {
                // Output JSON of received arguments on stderr [S1]
                Console.Error.WriteLine("FAKE_CHILD_ARGS_JSON:" + ToJsonArray(args));
                Console.Error.WriteLine(string.Format("FAKE_CHILD_PID:{0}", Process.GetCurrentProcess().Id));
                Console.Error.Flush();
            }

            if (delayMs > 0)
            {
                Thread.Sleep(delayMs);
            }

            if (scenario == "error")
            {
                Console.Error.WriteLine("FAKE_CHILD_INTENTIONAL_ERROR_EXIT_42");
                return 42;
            }

            if (scenario == "hang")
            {
                Thread.Sleep(60000);
                return 0;
            }

            if (scenario == "grandchild")
            {
                // Spawn a grandchild process [S4]
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                var psi = new ProcessStartInfo();
                psi.FileName = exePath;
                psi.Arguments = "--scenario hang";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;

                Process grandchild = Process.Start(psi);
                Console.Error.WriteLine(string.Format("FAKE_CHILD_PID:{0}", Process.GetCurrentProcess().Id));
                Console.Error.WriteLine(string.Format("FAKE_CHILD_GRANDCHILD_PID:{0}", grandchild.Id));
                Console.Error.Flush();

                // Keep child alive so test can verify both PIDs
                Thread.Sleep(60000);
                return 0;
            }

            if (scenario == "slow_stdout")
            {
                // Write byteCount bytes to stdout in chunks [S3]
                using (Stream output = Console.OpenStandardOutput())
                {
                    byte[] chunk = new byte[512];
                    for (int i = 0; i < chunk.Length; i++)
                    {
                        chunk[i] = (byte)(i % 256);
                    }

                    int bytesRemaining = byteCount;
                    while (bytesRemaining > 0)
                    {
                        int toWrite = Math.Min(chunk.Length, bytesRemaining);
                        output.Write(chunk, 0, toWrite);
                        output.Flush();
                        bytesRemaining -= toWrite;
                        if (chunkDelayMs > 0 && bytesRemaining > 0)
                        {
                            Thread.Sleep(chunkDelayMs);
                        }
                    }
                }
                Console.Error.WriteLine(string.Format("FAKE_CHILD_SLOW_STDOUT_COMPLETED:{0}", byteCount));
                return 0;
            }

            if (scenario == "burst")
            {
                // Write 64KB burst to stdout and stderr simultaneously [S3]
                int burstSize = 65536;
                byte[] pattern = new byte[burstSize];
                for (int i = 0; i < burstSize; i++)
                {
                    pattern[i] = (byte)(i % 256);
                }

                var t1 = new Thread(() =>
                {
                    using (Stream outStream = Console.OpenStandardOutput())
                    {
                        outStream.Write(pattern, 0, pattern.Length);
                        outStream.Flush();
                    }
                });

                var t2 = new Thread(() =>
                {
                    using (Stream errStream = Console.OpenStandardError())
                    {
                        errStream.Write(pattern, 0, pattern.Length);
                        errStream.Flush();
                    }
                });

                t1.Start();
                t2.Start();
                t1.Join();
                t2.Join();
                return 0;
            }

            // Normal echo scenario:
            Console.Error.WriteLine(string.Format("FAKE_CHILD_RECEIVED_ARGS:{0}", args.Length));

            // Read stdin until EOF and echo to stdout verbatim
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput())
            {
                byte[] buffer = new byte[4096];
                int read;
                int totalStdinBytes = 0;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    totalStdinBytes += read;
                    output.Write(buffer, 0, read);
                    output.Flush();
                }
                Console.Error.WriteLine(string.Format("FAKE_CHILD_TOTAL_STDIN_BYTES:{0}", totalStdinBytes));
            }

            return 0;
        }
    }
}
