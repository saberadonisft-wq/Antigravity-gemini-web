import contextlib
import io
import queue
import socket
import threading
import time
import unittest

from tools.probes.g2 import probe_ls_inference_routes as probe


class ProbeSafetyTests(unittest.TestCase):
    def test_metadata_logging_drops_quoted_secrets_and_prompts(self):
        marker = "SYNTHETIC_PRIVATE_MARKER"
        for line in [f'error Cookie: SID="{marker}"', f'error prompt="{marker}"',
                     f'error {{"api_key":"{marker}"}}', f'port metadata {marker}',
                     f'https server listening on 127.0.0.1:43210 payload="{marker}"']:
            self.assertNotIn(marker, probe.sanitize_log_line(line))
        self.assertEqual(probe.sanitize_log_line("unknown free-form text"), "")
        self.assertEqual(probe.sanitize_log_line(f'https server listening on 127.0.0.1:43210 payload="{marker}"'),
                         "https server listening on 127.0.0.1:43210")

    def test_actual_queue_output_only_contains_allowed_metadata(self):
        class Child:
            pid = 0
            returncode = None
            def poll(self): return None
        marker = "SYNTHETIC_PRIVATE_MARKER"
        messages = queue.Queue()
        messages.put(("stderr", f'error Cookie: SID="{marker}"'))
        messages.put(("stderr", f'https server listening on 127.0.0.1:43210 prompt="{marker}"'))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            ports = probe.discover_ports_from_queue(Child(), messages, timeout_s=0.1)
        self.assertEqual(ports["https"], 43210)
        self.assertNotIn(marker, output.getvalue())

    def test_arbitrary_flags_and_paths_are_not_persisted(self):
        marker = "SYNTHETIC_PRIVATE_MARKER"
        flags = probe.sanitize_probe_flags(["--unknown", marker, "-cloud_code_endpoint=https://example.invalid/?token=" + marker,
                                             "-model_api_client_type=gemini", "-c", marker])
        self.assertNotIn(marker, str(flags))
        self.assertIn("-model_api_client_type=gemini", flags)
        self.assertEqual(probe.safe_mock_path("/" + marker), "/[UNRECOGNIZED]")

    def test_shutdown_interrupts_a_continuously_dripping_body(self):
        server = probe.SafeMockServer(probe.get_free_port())
        entered = threading.Event()
        original = server._handler_cls.do_POST
        def tracked(handler):
            entered.set()
            original(handler)
        server._handler_cls.do_POST = tracked
        server.start()
        client = socket.create_connection(("127.0.0.1", server.port), timeout=1)
        finished = threading.Event()
        def drip():
            while not finished.wait(0.05):
                try: client.sendall(b"x")
                except OSError: break
        feeder = threading.Thread(target=drip, daemon=True)
        stopper = None
        failures = []
        try:
            client.sendall(b"POST /test HTTP/1.0\r\nContent-Length: 100000\r\n\r\nx")
            self.assertTrue(entered.wait(timeout=1))
            feeder.start()
            def stop():
                try: server.stop(timeout_s=0.5)
                except Exception as error: failures.append(error)
            stopper = threading.Thread(target=stop, daemon=True)
            stopper.start()
            stopper.join(timeout=0.8)
            self.assertFalse(stopper.is_alive(), "Shutdown must not wait for a complete or idle body")
            self.assertEqual(failures, [])
        finally:
            finished.set()
            try: client.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            client.close()
            if feeder.ident is not None: feeder.join(timeout=1)
            if stopper is not None: stopper.join(timeout=2)
            server.stop(timeout_s=1)

    def test_unexpected_handler_error_is_redacted_and_fails_validation(self):
        server = probe.SafeMockServer(probe.get_free_port())
        marker = "SYNTHETIC_PRIVATE_HANDLER_MARKER"
        entered = threading.Event()
        def fail(handler):
            entered.set()
            raise RuntimeError(marker)
        server._handler_cls.do_GET = fail
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            server.start()
            try:
                with socket.create_connection(("127.0.0.1", server.port), timeout=1) as client:
                    client.sendall(b"GET /test HTTP/1.0\r\n\r\n")
                    self.assertTrue(entered.wait(timeout=1))
                    client.recv(1)  # handler exits and closes the owned connection
                with self.assertRaisesRegex(RuntimeError, "handler failed"):
                    server.stop(timeout_s=1)
            finally:
                server.stop(timeout_s=1)
        self.assertNotIn(marker, output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())
        self.assertIn("[REDACTED]", output.getvalue())


if __name__ == "__main__":
    unittest.main()
