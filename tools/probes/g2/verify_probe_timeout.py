#!/usr/bin/env python3
"""
Verification: verify_probe_timeout.py
Verifies that probe times out and terminates a silent child process strictly within the deadline,
leaving zero orphan processes.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from probe_ls_inference_routes import (
    verify_log_sanitization,
    verify_mock_server_incomplete_body_timeout,
    verify_timeout_on_silent_child,
)

if __name__ == "__main__":
    t0 = time.monotonic()
    v7_ok = verify_log_sanitization()
    v8_mock_ok = verify_mock_server_incomplete_body_timeout()
    v8_timeout_ok = verify_timeout_on_silent_child()
    t1 = time.monotonic()
    print(f"Verification completed in {t1 - t0:.2f}s. Result: {v7_ok and v8_mock_ok and v8_timeout_ok}")
    if not (v7_ok and v8_mock_ok and v8_timeout_ok):
        sys.exit(1)
    sys.exit(0)

