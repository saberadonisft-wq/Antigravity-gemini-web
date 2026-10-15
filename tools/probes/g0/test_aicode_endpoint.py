#!/usr/bin/env python3
"""
Probe: test_aicode_endpoint.py
Tests whether setting AICODE_ENDPOINT_URL causes agy.exe to route catalog/model
requests to a mock server, or if models are embedded locally.
"""

import http.server
import socketserver
import threading
import os
import sys
import subprocess
import time
import json
import socket
import urllib.request
import urllib.error

# Ensure tools/probes/g0 is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from safe_logging import format_http_event

received_requests = []

class SafeMockHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b""
        
        event_str = format_http_event("POST", self.path, dict(self.headers), len(body), 200)
        print(f"[MockServer] {event_str}")
        received_requests.append({
            "path": self.path.split("?")[0],
            "method": "POST",
            "body_len": len(body),
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        event_str = format_http_event("GET", self.path, dict(self.headers), 0, 200)
        print(f"[MockServer] {event_str}")
        received_requests.append({
            "path": self.path.split("?")[0],
            "method": "GET",
            "body_len": 0,
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format, *args):
        pass  # Suppress default noisy stdio logging

def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def run_probe(agy_path: str = r"C:\Users\vhc\.gemini\bin\agy.exe", timeout_s: float = 15.0) -> dict:
    if not os.path.exists(agy_path):
        return {
            "test": "test_aicode_endpoint",
            "status": "NOT_TESTED",
            "reason": f"Binary not found: {agy_path}",
        }

    server = None
    server_thread = None
    proc = None
    port = get_free_port()
    hub_port = get_free_port()

    result = {
        "test": "test_aicode_endpoint",
        "status": "FAILED",
        "ready": False,
        "rpc_success": False,
        "models_count": 0,
        "mock_requests_received": 0,
        "inference_route_observed": False,
    }

    try:
        # 1. Bind mock server
        server = socketserver.TCPServer(("127.0.0.1", port), SafeMockHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        print(f"[Probe] Mock server listening on port {port}")

        # 2. Setup isolated env
        probe_env = os.environ.copy()
        # Test ONLY AICODE_ENDPOINT_URL isolated
        probe_env["AICODE_ENDPOINT_URL"] = f"http://127.0.0.1:{port}"

        cmd = [
            agy_path,
            "--hub",
            f"--hub-port={hub_port}",
            "--app_data_dir=test_probe",
            "--csrf_token=probe-test-token",
        ]
        print(f"[Probe] Spawning agy on hub port {hub_port} with AICODE_ENDPOINT_URL=127.0.0.1:{port}")
        proc = subprocess.Popen(cmd, env=probe_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # 3. Wait for readiness
        start_time = time.time()
        while time.time() - start_time < timeout_s:
            if proc.poll() is not None:
                raise RuntimeError(f"agy.exe exited prematurely with code {proc.returncode}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{hub_port}/healthz", timeout=1.0) as r:
                    if r.status == 200:
                        result["ready"] = True
                        break
            except Exception:
                time.sleep(0.3)

        if not result["ready"]:
            raise TimeoutError(f"agy.exe failed to pass healthz within {timeout_s}s")

        # 4. Call GetAvailableModels RPC
        req = urllib.request.Request(
            f"http://127.0.0.1:{hub_port}/exa.language_server_pb.LanguageServerService/GetAvailableModels",
            data=b"{}",
            headers={"Content-Type": "application/json", "x-codeium-csrf-token": "probe-test-token"}
        )
        with urllib.request.urlopen(req, timeout=5.0) as r:
            if r.status != 200:
                raise RuntimeError(f"GetAvailableModels returned HTTP status {r.status}")
            data = json.loads(r.read().decode())
            result["rpc_success"] = True
            models_map = data.get("response", data).get("models", {})
            result["models_count"] = len(models_map)

        time.sleep(1.0)
        result["mock_requests_received"] = len(received_requests)
        result["catalog_request_observed"] = (len(received_requests) > 0)
        result["inference_route_observed"] = False
        
        # In this catalog test, success means: agy ran, responded with its catalog,
        # and we observed whether AICODE_ENDPOINT_URL was called for catalog retrieval.
        result["status"] = "PASSED"

    finally:
        # Strict cleanup order
        if proc:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                    proc.wait(timeout=3)
                except Exception:
                    pass
        if server:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
        if server_thread and server_thread.is_alive():
            server_thread.join(timeout=2)

    return result

if __name__ == "__main__":
    res = run_probe()
    print(json.dumps(res, indent=2))
    if res["status"] != "PASSED":
        sys.exit(1)
    sys.exit(0)
