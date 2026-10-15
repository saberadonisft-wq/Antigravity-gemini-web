import sys
import os
import subprocess
import time
import json
import socket
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from safe_logging import SafeProbeLogger

# Dynamic port allocation helper
def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def run_probe(var_to_test="JETSKI_SERVICE_ENDPOINT_URL", agy_path=r"C:\Users\vhc\.gemini\bin\agy.exe", timeout_s=10):
    port = find_free_port()
    hub_port = find_free_port()
    received_requests = []

    class MockHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            
            # Record sanitized request metadata
            request_info = {
                "method": "POST",
                "path": self.path,
                "content_length": content_length,
                "has_body": content_length > 0
            }
            received_requests.append(request_info)
            SafeProbeLogger.log_request(self.command, self.path, self.headers, body)
            
            # Minimal ConnectRPC response mock
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{}')

        def log_message(self, format, *args):
            return

    server = None
    proc = None
    server_thread = None

    result = {
        "variable_tested": var_to_test,
        "mock_port": port,
        "hub_port": hub_port,
        "ready": False,
        "start_cascade_outcome": "NOT_CALLED",
        "requests_received": [],
        "control_plane_route_observed": False,
        "inference_request_observed": False,
        "token_stream_decoded": False,
        "inference_route_verified": False,
        "status": "NOT_RUN",
        "criteria": {}
    }

    try:
        # Start mock server
        server = HTTPServer(('127.0.0.1', port), MockHandler)
        server_thread = threading.Thread(target=server.serve_forever)
        server_thread.daemon = True
        server_thread.start()
        print(f"[Probe] Mock server listening on port {port}")

        # Prepare isolated environment
        probe_env = os.environ.copy()
        
        # Clear candidate variables
        probe_env.pop("AICODE_ENDPOINT_URL", None)
        probe_env.pop("JETSKI_SERVICE_ENDPOINT_URL", None)
        probe_env.pop("GOOGLE_VERTEX_BASE_URL", None)
        probe_env.pop("ANTIGRAVITY_ENDPOINT", None)

        # Set ONLY the single variable under test
        if var_to_test == "JETSKI_SERVICE_ENDPOINT_URL":
            probe_env["JETSKI_SERVICE_ENDPOINT_URL"] = f"http://127.0.0.1:{port}"
        elif var_to_test == "AICODE_ENDPOINT_URL":
            probe_env["AICODE_ENDPOINT_URL"] = f"127.0.0.1:{port}"
        elif var_to_test == "GOOGLE_VERTEX_BASE_URL":
            probe_env["GOOGLE_VERTEX_BASE_URL"] = f"http://127.0.0.1:{port}"
        elif var_to_test == "BASELINE":
            pass # No variables set
        else:
            raise ValueError(f"Unknown variable to test: {var_to_test}")

        cmd = [
            agy_path,
            "--hub",
            f"--hub-port={hub_port}",
            "--app_data_dir=test_probe",
            "--csrf_token=probe-test-token",
        ]
        print(f"[Probe] Spawning agy on hub port {hub_port} with {var_to_test}=http://127.0.0.1:{port}")
        proc = subprocess.Popen(cmd, env=probe_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # Readiness probe
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

        # Call StartCascade
        req_body = json.dumps({
            "initialPrompt": "Hello test probe",
            "workspaceUris": ["file:///d:/Antigravity-gemini-web"],
        }).encode("utf-8")

        req = urllib.request.Request(
            f"http://127.0.0.1:{hub_port}/exa.language_server_pb.LanguageServerService/StartCascade",
            data=req_body,
            headers={"Content-Type": "application/json", "x-codeium-csrf-token": "probe-test-token"}
        )

        cascade_success = False
        try:
            with urllib.request.urlopen(req, timeout=5.0) as r:
                result["start_cascade_outcome"] = f"HTTP_{r.status}"
                cascade_success = (r.status == 200)
        except urllib.error.HTTPError as e:
            result["start_cascade_outcome"] = f"HTTP_{e.code}_ValidationFailed"
            cascade_success = False
        except Exception as e:
            result["start_cascade_outcome"] = f"Error_{type(e).__name__}"
            cascade_success = False

        time.sleep(1.5)
        result["requests_received"] = [r["path"] for r in received_requests]
        
        # Strict criteria evaluation [F6 regression fix]
        result["control_plane_route_observed"] = any(
            "fetchUserInfo" in r["path"] and r["has_body"] for r in received_requests
        )
        result["inference_request_observed"] = any(
            ("StreamGenerateContent" in r["path"] or "v1/chat" in r["path"]) and r["has_body"]
            for r in received_requests
        )
        # Token stream requires actually decoding streaming chunks from the target
        result["token_stream_decoded"] = False
        
        # Inference route verified ONLY if all 3 conditions hold:
        # 1. StartCascade succeeds (HTTP 200)
        # 2. Inference request was observed with body
        # 3. Stream was decoded
        result["inference_route_verified"] = (
            cascade_success and
            result["inference_request_observed"] and
            result["token_stream_decoded"]
        )

        result["criteria"] = {
            "readiness": result["ready"],
            "control_plane_route_observed": result["control_plane_route_observed"],
            "start_cascade_success": cascade_success,
            "inference_request_observed": result["inference_request_observed"],
            "token_stream_decoded": result["token_stream_decoded"],
            "inference_route_verified": result["inference_route_verified"],
        }

        # Status: If StartCascade validation failed, status is FAILED for end-to-end inference!
        if var_to_test == "BASELINE":
            result["status"] = "PASSED" if result["ready"] else "FAILED"
        elif var_to_test == "JETSKI_SERVICE_ENDPOINT_URL":
            # Control plane observed, but cascade validation failed -> FAILED for inference
            result["status"] = "PASSED" if result["control_plane_route_observed"] and cascade_success else "FAILED"
        else:
            result["status"] = "PASSED" if result["inference_route_verified"] else "FAILED"

    finally:
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
            server_thread.join(timeout=2.0)

    print("\n--- Probe Structured Result ---")
    print(json.dumps(result, indent=2))
    return result

run_isolated_probe = run_probe

if __name__ == "__main__":
    var = sys.argv[1] if len(sys.argv) > 1 else "JETSKI_SERVICE_ENDPOINT_URL"
    res = run_probe(var)
    if res["status"] != "PASSED":
        print(f"\n[Probe] Probe ended with status: {res['status']}")
        # Non-zero exit code if test failed
        sys.exit(1)
    sys.exit(0)
