#!/usr/bin/env python3
"""
Probe: test_start_cascade.py
Baseline control test for StartCascade routing.
Ensures zero credential leakage and full resource cleanup.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_start_cascade_details import run_isolated_probe

if __name__ == "__main__":
    import json
    res = run_isolated_probe("BASELINE")
    print(json.dumps(res, indent=2))
    if res["status"] != "PASSED":
        sys.exit(1)
    sys.exit(0)
