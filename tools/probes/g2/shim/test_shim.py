import os
import sys
import time
import json
import subprocess
import unittest

SHIM_DIR = os.path.dirname(os.path.abspath(__file__))
SHIM_EXE = os.path.join(SHIM_DIR, "antigravity_shim.exe")
FAKE_CHILD_EXE = os.path.join(SHIM_DIR, "fake_child.exe")
TEST_LOG_PATH = os.path.join(SHIM_DIR, "test_shim.log")


def is_pid_running(pid):
    """Check if process with given PID exists in Windows."""
    if pid <= 0:
        return False
    try:
        # Use tasklist filter to check existence on Windows
        output = subprocess.check_output(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            stderr=subprocess.DEVNULL
        ).decode("utf-8", errors="replace")
        return str(pid) in output
    except Exception:
        return False


class AntigravityShimHardenedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(SHIM_EXE):
            raise RuntimeError(f"Shim executable not found at: {SHIM_EXE}. Run build.ps1 first.")
        if not os.path.exists(FAKE_CHILD_EXE):
            raise RuntimeError(f"Fake child executable not found at: {FAKE_CHILD_EXE}. Run build.ps1 first.")

    def setUp(self):
        if os.path.exists(TEST_LOG_PATH):
            try:
                os.remove(TEST_LOG_PATH)
            except OSError:
                pass

    def tearDown(self):
        if os.path.exists(TEST_LOG_PATH):
            try:
                os.remove(TEST_LOG_PATH)
            except OSError:
                pass

    def test_01_token_round_trip_equality(self):
        """[S1 Regression] Verifies that Windows argv quoting preserves 100% of tokens verbatim."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        test_tokens = [
            "--scenario", "echo",
            "",  # empty token
            "token with spaces",
            "token\twith\ttabs",
            "token\nwith\nnewlines",
            "C:\\Program Files\\Antigravity\\",  # path ending with backslash
            "foo\\\\\"bar",  # run of backslashes before quote
            "Tiếng Việt Có Dấu 2026",  # Unicode
            "--flag_equals=value with spaces and=equals",
            "--normal_flag", "normal_value"
        ]

        proc = subprocess.Popen(
            [SHIM_EXE] + test_tokens,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        stdout_bytes, stderr_bytes = proc.communicate(input=b"test-stdin", timeout=10)
        self.assertEqual(proc.returncode, 0, f"Expected returncode 0. Stderr: {stderr_bytes}")

        stderr_str = stderr_bytes.decode("utf-8", errors="replace")
        # Find JSON line
        json_prefix = "FAKE_CHILD_ARGS_JSON:"
        self.assertIn(json_prefix, stderr_str)
        for line in stderr_str.splitlines():
            if line.startswith(json_prefix):
                raw_json = line[len(json_prefix):]
                received_tokens = json.loads(raw_json)
                self.assertEqual(
                    received_tokens,
                    test_tokens,
                    "Every argument token must match verbatim round-trip!"
                )
                break

    def test_02_redaction_space_and_equals_syntax(self):
        """[S2 Regression] Verifies that sensitive keys are redacted in both --key value and --key=value formats."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        secret_csrf_space = "SYNTHETIC_CSRF_SPACE_SECRET_98765"
        secret_csrf_equals = "SYNTHETIC_CSRF_EQUALS_SECRET_43210"
        secret_ext_space = "SYNTHETIC_EXT_SPACE_SECRET_11111"
        secret_ext_equals = "SYNTHETIC_EXT_EQUALS_SECRET_22222"
        secret_api_space = "SYNTHETIC_API_KEY_SPACE_33333"
        secret_api_equals = "SYNTHETIC_API_KEY_EQUALS_44444"

        test_tokens = [
            "--scenario", "echo",
            "--csrf_token", secret_csrf_space,
            f"--csrf_token={secret_csrf_equals}",
            "--extension_server_csrf_token", secret_ext_space,
            f"--extension_server_csrf_token={secret_ext_equals}",
            "--api_key", secret_api_space,
            f"--api_key={secret_api_equals}",
            "--extension_server_port", "54321"  # non-sensitive
        ]

        proc = subprocess.Popen(
            [SHIM_EXE] + test_tokens,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        _, stderr_bytes = proc.communicate(input=b"", timeout=10)
        self.assertEqual(proc.returncode, 0)

        # Inspect log file
        self.assertTrue(os.path.exists(TEST_LOG_PATH), "Log file must exist")
        with open(TEST_LOG_PATH, "r", encoding="utf-8") as f:
            log_content = f.read()

        # Zero synthetic secrets must appear in log
        self.assertNotIn(secret_csrf_space, log_content, "Space-separated CSRF secret leaked in log!")
        self.assertNotIn(secret_csrf_equals, log_content, "Equals-separated CSRF secret leaked in log!")
        self.assertNotIn(secret_ext_space, log_content, "Space-separated extension secret leaked in log!")
        self.assertNotIn(secret_ext_equals, log_content, "Equals-separated extension secret leaked in log!")
        self.assertNotIn(secret_api_space, log_content, "Space-separated api key leaked in log!")
        self.assertNotIn(secret_api_equals, log_content, "Equals-separated api key leaked in log!")

        # Verify safe metadata remained
        self.assertIn("54321", log_content, "Safe non-sensitive port should be logged")
        self.assertIn("[REDACTED]", log_content, "Redaction placeholder must be used")

    def test_03_slow_consumer_and_backpressure_drain(self):
        """[S3 Regression] Verifies slow reader receives 100% of 12,000 bytes without premature wrapper exit."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        total_bytes_expected = 12000

        proc = subprocess.Popen(
            [SHIM_EXE, "--scenario", "slow_stdout", "--byte_count", str(total_bytes_expected), "--chunk_delay_ms", "5"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        # Read slowly from stdout in chunks with delays to simulate slow consumer backpressure
        received_chunks = []
        total_received = 0
        while True:
            chunk = proc.stdout.read(512)
            if not chunk:
                break
            received_chunks.append(chunk)
            total_received += len(chunk)
            time.sleep(0.01)  # 10ms slow reader delay

        proc.stdout.close()
        proc.stderr.close()
        proc.stdin.close()
        proc.wait(timeout=15)

        self.assertEqual(proc.returncode, 0, f"Expected returncode 0, got {proc.returncode}")
        self.assertEqual(total_received, total_bytes_expected, f"Expected {total_bytes_expected} bytes, got {total_received}!")

    def test_04_burst_simultaneous_stdout_and_stderr(self):
        """[S3 Regression] Verifies wrapper drains simultaneous 64KB bursts on stdout and stderr without deadlocking."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        burst_size = 65536

        proc = subprocess.Popen(
            [SHIM_EXE, "--scenario", "burst"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        stdout_bytes, stderr_bytes = proc.communicate(timeout=15)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(len(stdout_bytes), burst_size, "STDOUT burst size must match 65536 bytes")
        self.assertEqual(len(stderr_bytes), burst_size, "STDERR burst size must match 65536 bytes")

    def test_05_job_object_grandchild_cleanup(self):
        """[S4 Regression] Verifies Windows Job Object terminates child and grandchild upon wrapper termination."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        proc = subprocess.Popen(
            [SHIM_EXE, "--scenario", "grandchild"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        # Read PIDs from stderr
        child_pid = None
        grandchild_pid = None

        start_time = time.time()
        while time.time() - start_time < 5:
            line = proc.stderr.readline().decode("utf-8", errors="replace")
            if "FAKE_CHILD_PID:" in line:
                child_pid = int(line.split("FAKE_CHILD_PID:")[1].strip())
            if "FAKE_CHILD_GRANDCHILD_PID:" in line:
                grandchild_pid = int(line.split("FAKE_CHILD_GRANDCHILD_PID:")[1].strip())
            if child_pid and grandchild_pid:
                break

        self.assertIsNotNone(child_pid, "Must capture child PID")
        self.assertIsNotNone(grandchild_pid, "Must capture grandchild PID")

        # Verify both processes are alive initially
        self.assertTrue(is_pid_running(child_pid), f"Child process {child_pid} should be running")
        self.assertTrue(is_pid_running(grandchild_pid), f"Grandchild process {grandchild_pid} should be running")

        # Now kill the wrapper process
        proc.terminate()
        proc.wait(timeout=5)
        proc.stdin.close()
        proc.stdout.close()
        proc.stderr.close()

        # Wait up to 3 seconds for OS Job Object to terminate all descendant processes
        time.sleep(1.0)
        self.assertFalse(is_pid_running(child_pid), f"Child process {child_pid} must be terminated by Job Object!")
        self.assertFalse(is_pid_running(grandchild_pid), f"Grandchild process {grandchild_pid} must be terminated by Job Object!")

    def test_06_job_object_fail_closed(self):
        """[S4 Regression] Verifies wrapper fails closed (code 124) when Job Object cannot be initialized."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH
        env["ANTIGRAVITY_SIMULATE_JOB_FAIL"] = "1"

        proc = subprocess.Popen(
            [SHIM_EXE, "--scenario", "echo"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        _, stderr_bytes = proc.communicate(input=b"", timeout=5)
        self.assertEqual(proc.returncode, 124, "Must fail closed with code 124 when Job Object fails")
        self.assertIn("Job Object", stderr_bytes.decode("utf-8", errors="replace"))

    def test_07_exit_code_and_missing_binary(self):
        """Verifies error code propagation and missing target binary handling."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        # Non-zero exit code propagation
        proc = subprocess.Popen(
            [SHIM_EXE, "--scenario", "error"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )
        proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 42)

        # Missing target binary
        env["ANTIGRAVITY_TARGET_LS_PATH"] = os.path.join(SHIM_DIR, "non_existent_binary.exe")
        proc_missing = subprocess.Popen(
            [SHIM_EXE, "--test"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )
        _, err_bytes = proc_missing.communicate(timeout=5)
        self.assertEqual(proc_missing.returncode, 127)
        self.assertIn("Target binary does not exist", err_bytes.decode("utf-8", errors="replace"))

    def test_08_h1_metadata_allowlist_and_url_sanitization(self):
        """[H1 Regression] Verifies that endpoint URLs strip userinfo, query, fragment in split & equal format, and unknown flags/positional args are masked."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        secret_query_equal = "SYNTHETIC_ENDPOINT_QUERY_SECRET_EQUAL_11111"
        secret_userinfo_equal = "synthetic_user_equal:synthetic_pass_equal"
        secret_query_split = "SYNTHETIC_ENDPOINT_QUERY_SECRET_SPLIT_22222"
        secret_userinfo_split = "synthetic_user_split:synthetic_pass_split"
        secret_unknown_equal = "SYNTHETIC_UNKNOWN_FLAG_EQUAL_33333"
        secret_unknown_split = "SYNTHETIC_UNKNOWN_FLAG_SPLIT_44444"
        secret_positional = "SYNTHETIC_POSITIONAL_PROMPT_SECRET_55555"
        secret_blade_query = "SYNTHETIC_BLADE_SECRET_66666"

        test_tokens = [
            "--scenario", "echo",
            f"--cloud_code_endpoint=https://{secret_userinfo_equal}@example.invalid:8443/rpc?token={secret_query_equal}#myfrag",
            "--cloud_code_endpoint", f"https://{secret_userinfo_split}@example.invalid:9443/v1/call?key={secret_query_split}#frag2",
            f"--generative_service_addr=blade:google.ai.generative?secret={secret_blade_query}",
            f"--unknown_flag={secret_unknown_equal}",
            "--unknown_split_flag", secret_unknown_split,
            secret_positional,
            "--https_server_port", "64584",  # allowed numeric
            "--model_api_client_type", "ccpa",  # allowed identifier
        ]

        proc = subprocess.Popen(
            [SHIM_EXE] + test_tokens,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        _, stderr_bytes = proc.communicate(input=b"", timeout=10)
        self.assertEqual(proc.returncode, 0)

        # Inspect log file
        self.assertTrue(os.path.exists(TEST_LOG_PATH), "Log file must exist")
        with open(TEST_LOG_PATH, "r", encoding="utf-8") as f:
            log_content = f.read()

        # Zero synthetic secrets must appear in log
        self.assertNotIn(secret_query_equal, log_content, "Equal query secret leaked in log!")
        self.assertNotIn(secret_userinfo_equal, log_content, "Equal userinfo leaked in log!")
        self.assertNotIn(secret_query_split, log_content, "Split query secret leaked in log!")
        self.assertNotIn(secret_userinfo_split, log_content, "Split userinfo leaked in log!")
        self.assertNotIn(secret_unknown_equal, log_content, "Unknown equal flag value leaked in log!")
        self.assertNotIn(secret_unknown_split, log_content, "Unknown split flag value leaked in log!")
        self.assertNotIn(secret_positional, log_content, "Positional argument leaked in log!")
        self.assertNotIn(secret_blade_query, log_content, "Blade secret leaked in log!")

        # Verify safe metadata remained in sanitized form
        self.assertIn("https://example.invalid:8443/rpc", log_content, "Sanitized equal endpoint origin/path should remain")
        self.assertIn("https://example.invalid:9443/v1/call", log_content, "Sanitized split endpoint origin/path should remain")
        self.assertIn("blade:google.ai.generative", log_content, "Sanitized blade address should remain")
        self.assertIn("64584", log_content, "Allowed numeric port should remain")
        self.assertIn("ccpa", log_content, "Allowed model identifier should remain")
        self.assertIn("[ARG]", log_content, "Positional argument should be replaced with [ARG]")
        self.assertIn("[REDACTED]", log_content, "Unknown flag values should be replaced with [REDACTED]")

    def test_09_h2_early_pipe_close_fails_closed_code_128_and_terminates_child(self):
        """[H2 Regression] Verifies that when parent pipe closes early, wrapper returns code 128 (ERR_PIPE_FORWARDING_FAILED) and child process is terminated immediately."""
        env = os.environ.copy()
        env["ANTIGRAVITY_TARGET_LS_PATH"] = FAKE_CHILD_EXE
        env["ANTIGRAVITY_SHIM_LOG_PATH"] = TEST_LOG_PATH

        # Child configured to produce 50,000 bytes slowly (50ms per 512 bytes = ~5 seconds total runtime)
        proc = subprocess.Popen(
            [SHIM_EXE, "--scenario", "slow_stdout", "--byte_count", "50000", "--chunk_delay_ms", "50"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env
        )

        # Read child PID from stderr
        child_pid = None
        start_time = time.time()
        while time.time() - start_time < 5:
            line = proc.stderr.readline().decode("utf-8", errors="replace")
            if "FAKE_CHILD_PID:" in line:
                child_pid = int(line.split("FAKE_CHILD_PID:")[1].strip())
                break

        self.assertIsNotNone(child_pid, "Must capture child PID from stderr")
        self.assertTrue(is_pid_running(child_pid), f"Child process {child_pid} should be initially alive")

        # Read the first chunk from stdout, then abruptly close stdout pipe from parent
        initial_chunk = proc.stdout.read(512)
        self.assertTrue(len(initial_chunk) > 0, "Should read initial chunk")
        proc.stdout.close()  # Break the pipe

        # Wrapper must detect broken pipe on next write, kill child, and exit with code 128
        start_wait = time.time()
        proc.wait(timeout=5)
        elapsed = time.time() - start_wait
        proc.stdin.close()
        proc.stderr.close()

        self.assertLess(elapsed, 4.0, "Wrapper must terminate immediately upon pipe failure without waiting out full child runtime")
        self.assertEqual(proc.returncode, 128, f"Expected exit code 128 (ERR_PIPE_FORWARDING_FAILED), got {proc.returncode}")

        # Verify child process is dead
        time.sleep(0.5)
        self.assertFalse(is_pid_running(child_pid), f"Child process {child_pid} must be terminated when pipe breaks!")

        # Verify log records pipe forwarding failure
        with open(TEST_LOG_PATH, "r", encoding="utf-8") as f:
            log_content = f.read()
        self.assertIn("Forwarding pipe error", log_content, "Log must record forwarding pipe error")


if __name__ == "__main__":
    unittest.main()
