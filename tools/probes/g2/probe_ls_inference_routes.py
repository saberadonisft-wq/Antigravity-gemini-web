#!/usr/bin/env python3
"""
Probe: probe_ls_inference_routes.py
Empirically probes outbound inference and provider routing mechanisms in
the native language_server_windows_x64.exe binary.

Key hardening:
  - Non-blocking stdout/stderr reading via daemon threads and Queue.
  - Strict deadline (time.monotonic()) for every scenario (max 30s).
  - Robust process cleanup in finally (terminate -> wait -> kill).
  - All output flushed immediately (flush=True).
"""

import http.server
import json
import os
import queue
import re
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# Include safe logging
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "g0")))
from safe_logging import format_http_event, sanitize_path

LS_BINARY = r"D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe"
FAKE_CHILD_BINARY = os.path.abspath(os.path.join(os.path.dirname(__file__), "shim", "fake_child.exe"))
SCENARIO_TIMEOUT_S = 30.0


def sanitize_log_line(line: str) -> str:
    """Extract metadata, never pass through a free-form message or quoted value."""
    match = re.search(r"listening on random port at (\d+) for (HTTPS|HTTP)\b", line, re.I)
    if match:
        port, protocol = int(match[1]), match[2].lower()
    else:
        match = re.search(r"\b(https?|extension)(?: server)? listening on (?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)\b", line, re.I)
        if not match:
            severity = re.search(r"\b(error|fatal)\b", line, re.I)
            return f"[diagnostic] {severity[1].upper()} details=[REDACTED]" if severity else ""
        protocol, port = match[1].lower(), int(match[2])
    return f"{protocol} server listening on 127.0.0.1:{port}" if 0 < port <= 65535 else ""


def sanitize_probe_flags(flags: list) -> list:
    allowed = {"cloud_code_endpoint", "generative_service_addr", "inference_api_server_url", "model_api_client_type", "scenario"}
    result = []
    index = 0
    while index < len(flags):
        token = flags[index]
        head, sep, value = token.partition("=")
        name = head.lstrip("-")
        index += 1
        if not head.startswith("-") or name not in allowed:
            result.append("[ARG]")
            continue
        if not sep and index < len(flags):
            value = flags[index]
            index += 1
        safe = value if (name == "model_api_client_type" and value in {"ccpa", "gemini"}) or (name == "scenario" and value in {"hang", "echo"}) else "[REDACTED]"
        if re.fullmatch(r"(?:https?://)?(?:127\.0\.0\.1|localhost):[0-9]{1,5}/?", value):
            safe = value
        result.append(f"{head}={safe}")
    return result


def safe_mock_path(path: str) -> str:
    path = path.split("?", 1)[0]
    known = {"/", "/test", "/health", "/generate-health",
             "/exa.language_server_pb.LanguageServerService/GetAvailableModels",
             "/exa.language_server_pb.LanguageServerService/StartCascade"}
    return path if path in known else "/[UNRECOGNIZED]"


def is_pid_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        output = subprocess.check_output(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="replace")
        return str(pid) in output
    except Exception:
        return False


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class SafeMockServer:
    def __init__(self, port: int):
        self.port = port
        self.received_requests = []
        self._server = None
        self._thread = None
        self._connections = set()
        self._connections_lock = threading.Lock()
        self._stopping = threading.Event()
        self._handler_failed = False

        parent = self

        class Server(socketserver.TCPServer):
            def handle_error(self, request, client_address):
                error = sys.exc_info()[1]
                if parent._stopping.is_set() and isinstance(error, (ConnectionError, TimeoutError)):
                    return  # owned socket shutdown, not a handler failure
                parent._handler_failed = True
                print("[MockServer] Handler failed; details=[REDACTED]", file=sys.stderr, flush=True)

        self._server_cls = Server

        class Handler(http.server.BaseHTTPRequestHandler):
            timeout = 1.0  # Socket read timeout for client requests

            def setup(self):
                super().setup()
                with parent._connections_lock:
                    parent._connections.add(self.connection)
                if parent._stopping.is_set():
                    self.connection.shutdown(socket.SHUT_RDWR)

            def finish(self):
                try:
                    super().finish()
                finally:
                    with parent._connections_lock:
                        parent._connections.discard(self.connection)

            def do_POST(self):
                try:
                    self.connection.settimeout(1.0)
                    length = int(self.headers.get("Content-Length", 0))
                    if length < 0 or length > 1024 * 1024:
                        self.send_error(413)
                        return
                    deadline = time.monotonic() + 1.0
                    body_len = 0
                    while body_len < length:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError("Request body budget exhausted")
                        self.connection.settimeout(remaining)
                        chunk = self.rfile.read1(min(8192, length - body_len))
                        if not chunk:
                            raise EOFError("Incomplete request body")
                        body_len += len(chunk)
                except Exception:
                    try: self.send_error(408)
                    except Exception: pass
                    return

                event = {
                    "method": "POST",
                    "path": safe_mock_path(self.path),
                    "body_len": body_len,
                }
                parent.received_requests.append(event)
                sanitized_path = sanitize_path(event["path"])
                print(f"[MockServer:{parent.port}] Received POST {sanitized_path} (bytes: {body_len})", flush=True)
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b"{}")
                except Exception:
                    pass

            def do_GET(self):
                try:
                    self.connection.settimeout(1.0)
                except Exception:
                    pass
                event = {
                    "method": "GET",
                    "path": safe_mock_path(self.path),
                    "body_len": 0,
                }
                parent.received_requests.append(event)
                sanitized_path = sanitize_path(event["path"])
                print(f"[MockServer:{parent.port}] Received GET {sanitized_path}", flush=True)
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b"{}")
                except Exception:
                    pass

            def log_message(self, format, *args):
                pass

        self._handler_cls = Handler

    def start(self):
        self._server = self._server_cls(("127.0.0.1", self.port), self._handler_cls)
        self._server.timeout = 1.0
        self._thread = threading.Thread(target=lambda: self._server.serve_forever(poll_interval=0.05), daemon=True)
        self._thread.start()

    def stop(self, timeout_s: float = 2.0):
        if not self._server:
            return
        deadline = time.monotonic() + timeout_s
        self._stopping.set()
        with self._connections_lock:
            connections = list(self._connections)
        for connection in connections:
            try: connection.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        server = self._server
        stopping = threading.Thread(target=server.shutdown, daemon=True)
        stopping.start()
        stopping.join(timeout=max(0.0, deadline - time.monotonic()))
        if stopping.is_alive():
            raise TimeoutError("Mock server shutdown budget exhausted")
        server.server_close()
        if self._thread:
            self._thread.join(timeout=max(0.0, deadline - time.monotonic()))
            if self._thread.is_alive():
                raise TimeoutError("Mock server thread did not exit")
        self._server = None
        if self._handler_failed:
            raise RuntimeError("Mock server handler failed; details=[REDACTED]")


def spawn_process_with_queues(cmd: list, env: dict):
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,
        env=env,
    )
    q = queue.Queue()

    def reader(stream, stream_name):
        try:
            for raw_line in iter(stream.readline, b""):
                line_str = raw_line.decode("utf-8", errors="replace").strip()
                # Sanitize immediately before storing to queue
                safe_line = sanitize_log_line(line_str)
                if safe_line:
                    q.put((stream_name, safe_line))
        except Exception:
            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    t_out = threading.Thread(target=reader, args=(proc.stdout, "stdout"), daemon=True)
    t_err = threading.Thread(target=reader, args=(proc.stderr, "stderr"), daemon=True)
    t_out.start()
    t_err.start()

    return proc, q


def discover_ports_from_queue(proc: subprocess.Popen, q: queue.Queue, timeout_s: float = 10.0) -> dict:
    """Non-blocking port discovery from Queue with monotonic deadline."""
    ports = {"http": None, "https": None, "extension": None}
    deadline = time.monotonic() + timeout_s

    # Matches both standard Go server.go logs and ConnectRPC announcements:
    # e.g.: "Language server listening on random port at 64584 for HTTPS (gRPC)"
    # e.g.: "Language server listening on random port at 64581 for HTTP"
    # e.g.: "http server listening on 127.0.0.1:54321"
    port_at_re = re.compile(r"listening on random port at (\d+) for (HTTPS|HTTP)", re.IGNORECASE)
    http_re = re.compile(r"http(?: server)? listening on (?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)", re.IGNORECASE)
    https_re = re.compile(r"https(?: server)? listening on (?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)", re.IGNORECASE)
    ext_re = re.compile(r"extension server listening on (?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)", re.IGNORECASE)

    while time.monotonic() < deadline:
        if proc.poll() is not None and q.empty():
            print(f"[LS] Process PID {proc.pid} exited with code {proc.returncode} before port discovery", flush=True)
            break

        remaining = max(0.01, deadline - time.monotonic())
        try:
            stream_name, line = q.get(timeout=min(0.2, remaining))
            line = sanitize_log_line(line)
            if line:
                low = line.lower()
                if "listening" in low or "port" in low:
                    safe = sanitize_log_line(line)
                    print(f"[LS:{stream_name}:port] {safe}", flush=True)
                elif "error" in low or "fatal" in low:
                    safe = sanitize_log_line(line)
                    print(f"[LS:{stream_name}:diagnostic] {safe}", flush=True)

            m_port_at = port_at_re.search(line)
            if m_port_at:
                port_num = int(m_port_at.group(1))
                proto = m_port_at.group(2).upper()
                if proto == "HTTPS":
                    ports["https"] = port_num
                else:
                    ports["http"] = port_num

            m_http = http_re.search(line)
            if m_http:
                ports["http"] = int(m_http.group(1))

            m_https = https_re.search(line)
            if m_https:
                ports["https"] = int(m_https.group(1))

            m_ext = ext_re.search(line)
            if m_ext:
                ports["extension"] = int(m_ext.group(1))

            if ports["http"] or ports["https"]:
                print(f"[Probe] Discovered ports: {ports}", flush=True)
                break
        except queue.Empty:
            continue

    return ports


def run_single_probe(
    name: str,
    target_binary: str,
    extra_flags: list,
    mock_port: int,
    test_rpc: bool = True,
    scenario_timeout: float = SCENARIO_TIMEOUT_S,
) -> dict:
    scenario_start = time.monotonic()
    scenario_deadline = scenario_start + scenario_timeout

    result = {
        "scenario": name,
        "target_binary": target_binary,
        "flags": sanitize_probe_flags(extra_flags),
        "mock_port": mock_port,
        "spawn_ok": False,
        "target_pid": None,
        "ports": {},
        "mock_requests_received": [],
        "rpc_attempted": False,
        "rpc_status": None,
        "rpc_error": None,
        "elapsed_seconds": 0.0,
        "outbound_inference_observed": False,
        "inference_route_verified": False,
        "verdict": "UNRESOLVED",
    }

    mock_server = SafeMockServer(mock_port)
    mock_server.start()

    csrf_token = "probe-test-token-safe-12345"
    if target_binary == LS_BINARY:
        cmd = [
            target_binary,
            "-csrf_token", csrf_token,
            "-app_data_dir", "probe_test_g2",
            "-subclient_type", "ide",
        ] + extra_flags
    else:
        cmd = [target_binary] + extra_flags

    proc = None
    try:
        print(f"\n=======================================================", flush=True)
        print(f"Running Scenario: {name} (timeout={scenario_timeout}s)", flush=True)
        print(f"Binary: {target_binary}", flush=True)
        print(f"Flags (safe metadata): {sanitize_probe_flags(extra_flags)}", flush=True)
        print(f"=======================================================", flush=True)

        env = os.environ.copy()
        proc, q = spawn_process_with_queues(cmd, env)
        result["spawn_ok"] = True
        result["target_pid"] = proc.pid
        print(f"[Probe] Spawned process PID: {proc.pid}", flush=True)

        # Port discovery with remaining deadline
        remaining_time = max(0.0, scenario_deadline - time.monotonic())
        ports = discover_ports_from_queue(proc, q, timeout_s=min(10.0, remaining_time))
        result["ports"] = ports

        target_port = ports.get("http") or ports.get("https")
        is_https = (target_port == ports.get("https")) and (ports.get("http") is None)
        scheme = "https" if is_https else "http"

        if target_port and test_rpc and (time.monotonic() < scenario_deadline):
            result["rpc_attempted"] = True
            time.sleep(min(0.5, max(0.0, scenario_deadline - time.monotonic())))

            # Test GetAvailableModels
            try:
                rpc_url = f"{scheme}://127.0.0.1:{target_port}/exa.language_server_pb.LanguageServerService/GetAvailableModels"
                req = urllib.request.Request(
                    rpc_url,
                    data=b"{}",
                    headers={
                        "Content-Type": "application/json",
                        "x-codeium-csrf-token": csrf_token,
                    },
                )
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE

                remaining_rpc = scenario_deadline - time.monotonic()
                if remaining_rpc <= 0: raise TimeoutError("Scenario budget exhausted")
                with urllib.request.urlopen(req, timeout=min(3.0, remaining_rpc), context=ctx if is_https else None) as resp:
                    result["rpc_status"] = resp.status
                    print(f"[Probe] GetAvailableModels RPC status: {resp.status}", flush=True)
            except urllib.error.HTTPError as e:
                result["rpc_status"] = e.code
                result["rpc_error"] = f"HTTPError {e.code}"
                print(f"[Probe] GetAvailableModels HTTP error: {e.code}", flush=True)
            except Exception as e:
                result["rpc_error"] = type(e).__name__
                print(f"[Probe] GetAvailableModels failed: {type(e).__name__}", flush=True)

            # Test StartCascade
            try:
                cascade_url = f"{scheme}://127.0.0.1:{target_port}/exa.language_server_pb.LanguageServerService/StartCascade"
                synthetic_payload = json.dumps({
                    "metadata": {
                        "ide_name": "antigravity",
                        "ide_version": "1.107.0",
                        "extension_version": "0.1.0",
                    },
                    "prompt": "SYNTHETIC_TEST_PROMPT_PING",
                }).encode("utf-8")

                req_cascade = urllib.request.Request(
                    cascade_url,
                    data=synthetic_payload,
                    headers={
                        "Content-Type": "application/json",
                        "x-codeium-csrf-token": csrf_token,
                    },
                )
                remaining_rpc = scenario_deadline - time.monotonic()
                if remaining_rpc <= 0: raise TimeoutError("Scenario budget exhausted")
                with urllib.request.urlopen(req_cascade, timeout=min(3.0, remaining_rpc), context=ctx if is_https else None) as resp:
                    print(f"[Probe] StartCascade status: {resp.status}", flush=True)
            except urllib.error.HTTPError as e:
                print(f"[Probe] StartCascade HTTP error: {e.code}", flush=True)
            except Exception as e:
                print(f"[Probe] StartCascade failed: {type(e).__name__}", flush=True)

        time.sleep(min(1.0, max(0.0, scenario_deadline - time.monotonic())))
        result["mock_requests_received"] = mock_server.received_requests

        if len(mock_server.received_requests) > 0:
            result["outbound_inference_observed"] = True
            # V1 fix: observation of traffic does NOT prove verified native inference
            result["inference_route_verified"] = False
            result["verdict"] = "UNVERIFIED_OBSERVATION"
        elif not ports.get("http") and not ports.get("https"):
            result["verdict"] = "TIMEOUT_OR_NO_PORT"
            result["inference_route_verified"] = False
            result["blocker"] = "No listening port observed; startup cause remains unverified"
            result["hypothesis"] = "IDE initialization/launch contract may be required; comparison not tested"
        else:
            result["verdict"] = "NO_OUTBOUND_TRAFFIC"
            result["inference_route_verified"] = False

    finally:
        result["elapsed_seconds"] = round(time.monotonic() - scenario_start, 3)
        if proc:
            pid = proc.pid
            try:
                if proc.poll() is None:
                    print(f"[Probe] Clean shutdown: terminating PID {pid}...", flush=True)
                    proc.terminate()
                    proc.wait(timeout=2.0)
            except Exception:
                pass
            try:
                if proc.poll() is None:
                    print(f"[Probe] Force killing PID {pid}...", flush=True)
                    proc.kill()
                    proc.wait(timeout=2.0)
            except Exception:
                pass
            try:
                if proc.stdin: proc.stdin.close()
                if proc.stdout: proc.stdout.close()
                if proc.stderr: proc.stderr.close()
            except Exception:
                pass
            print(f"[Probe] Process PID {pid} cleaned up. HasExited={proc.poll() is not None}", flush=True)
        mock_server.stop(timeout_s=2.0)

    return result


def verify_log_sanitization():
    """Validates V7: secret tokens in stdout/stderr queue are strictly redacted and never leaked."""
    print("\n>>> VERIFYING V7 LOG SANITIZATION <<<", flush=True)
    secret_marker = "SYNTHETIC_G2_LOG_SECRET_XYZ"
    lines = [f'error Cookie: SID="{secret_marker}"', f'error prompt="{secret_marker}"', f'Authentication failed with api_key={secret_marker}', f'https server listening on 127.0.0.1:12345 payload="{secret_marker}"']
    for line in lines:
        assert secret_marker not in sanitize_log_line(line), "Free-form data reached metadata output"
    assert sanitize_log_line(lines[-1]) == "https server listening on 127.0.0.1:12345"
    print(">>> V7 LOG SANITIZATION PASSED: Sensitive markers redacted successfully <<<\n", flush=True)
    return True


def verify_mock_server_incomplete_body_timeout():
    """Validates V8: SafeMockServer does not hang forever when client sends incomplete POST body."""
    print("\n>>> VERIFYING V8 MOCK SERVER INCOMPLETE BODY HANDLING <<<", flush=True)
    port = get_free_port()
    srv = SafeMockServer(port)
    srv.start()

    # Client connects and sends Content-Length: 1000 but only 10 bytes then stalls
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", port))
    sock.sendall(b"POST /test HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n1234567890")

    # SafeMockServer should handle socket timeout without hanging shutdown
    t_stop_start = time.monotonic()
    srv.stop(timeout_s=3.0)
    stop_elapsed = time.monotonic() - t_stop_start
    sock.close()

    assert stop_elapsed < 4.0, f"Mock server shutdown took too long: {stop_elapsed:.2f}s"
    print(f">>> V8 MOCK SERVER TIMEOUT PASSED: Server shutdown cleanly in {stop_elapsed:.2f}s <<<\n", flush=True)
    return True


def verify_timeout_on_silent_child():
    """Validates that probe strictly times out and cleans up when child is silent but running."""
    print("\n>>> VERIFYING TIMEOUT ON SILENT CHILD PROCESS <<<", flush=True)
    if not os.path.exists(FAKE_CHILD_BINARY):
        raise RuntimeError(f"Fake child binary not found: {FAKE_CHILD_BINARY}")

    port = get_free_port()
    t_start = time.monotonic()
    scenario_budget = 3.0
    cleanup_budget = 2.0
    total_budget = scenario_budget + cleanup_budget

    res = run_single_probe(
        name="Verification_Silent_Child_Timeout",
        target_binary=FAKE_CHILD_BINARY,
        extra_flags=["--scenario", "hang"],
        mock_port=port,
        test_rpc=False,
        scenario_timeout=scenario_budget,
    )
    elapsed = time.monotonic() - t_start

    pid = res["target_pid"]
    print(f"[Verification] Elapsed: {elapsed:.2f}s (Scenario budget: {scenario_budget}s, Cleanup budget: {cleanup_budget}s), Target PID: {pid}", flush=True)
    assert pid is not None, "Target PID must be recorded"
    assert elapsed <= total_budget + 1.0, f"Elapsed {elapsed}s exceeded total budget {total_budget + 1.0}s"
    assert not is_pid_running(pid), f"PID {pid} must not be running after cleanup!"
    assert res["verdict"] == "TIMEOUT_OR_NO_PORT", f"Expected TIMEOUT_OR_NO_PORT, got {res['verdict']}"
    print(">>> VERIFICATION PASSED: Silent child was terminated cleanly within total budget <<<\n", flush=True)
    return True


def main():
    # 1. Verification steps required by review (V7, V8, timeout):
    verify_log_sanitization()
    verify_mock_server_incomplete_body_timeout()
    verify_timeout_on_silent_child()

    if not os.path.exists(LS_BINARY):
        print(f"FATAL: Binary not found at {LS_BINARY}", flush=True)
        sys.exit(1)

    suite_results = []

    # Scenario 1: Baseline (default CCPA, no override flags)
    port1 = get_free_port()
    res1 = run_single_probe(
        name="1_Baseline_Default_CCPA",
        target_binary=LS_BINARY,
        extra_flags=[],
        mock_port=port1,
        test_rpc=True,
        scenario_timeout=SCENARIO_TIMEOUT_S,
    )
    suite_results.append(res1)

    # Scenario 2: Override -cloud_code_endpoint to mock server
    port2 = get_free_port()
    res2 = run_single_probe(
        name="2_Override_CloudCodeEndpoint_Http",
        target_binary=LS_BINARY,
        extra_flags=[f"-cloud_code_endpoint=http://127.0.0.1:{port2}"],
        mock_port=port2,
        test_rpc=True,
        scenario_timeout=SCENARIO_TIMEOUT_S,
    )
    suite_results.append(res2)

    # Scenario 3: Override -model_api_client_type=gemini and -generative_service_addr
    port3 = get_free_port()
    res3 = run_single_probe(
        name="3_Override_ModelApiClientType_Gemini",
        target_binary=LS_BINARY,
        extra_flags=[
            "-model_api_client_type=gemini",
            f"-generative_service_addr=127.0.0.1:{port3}",
        ],
        mock_port=port3,
        test_rpc=True,
        scenario_timeout=SCENARIO_TIMEOUT_S,
    )
    suite_results.append(res3)

    # Scenario 4: Override -inference_api_server_url
    port4 = get_free_port()
    res4 = run_single_probe(
        name="4_Override_InferenceApiServerUrl",
        target_binary=LS_BINARY,
        extra_flags=[f"-inference_api_server_url=http://127.0.0.1:{port4}"],
        mock_port=port4,
        test_rpc=True,
        scenario_timeout=SCENARIO_TIMEOUT_S,
    )
    suite_results.append(res4)

    # Write results JSON
    output_path = os.path.join(os.path.dirname(__file__), "inference_routes_probe_results.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(suite_results, f, indent=2)

    print("\n=======================================================", flush=True)
    print("PROBE SUITE SUMMARY:", flush=True)
    for r in suite_results:
        print(f"  - {r['scenario']}: verdict={r['verdict']}, mock_reqs={len(r['mock_requests_received'])}, rpc_status={r['rpc_status']}, elapsed={r['elapsed_seconds']}s", flush=True)
    print(f"Results written to: {output_path}", flush=True)
    print("=======================================================", flush=True)


if __name__ == "__main__":
    main()
