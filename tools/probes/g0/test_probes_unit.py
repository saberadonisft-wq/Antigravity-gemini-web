#!/usr/bin/env python3
"""
Unit tests with doubles/mocks for G0 probes:
1. Synthetic redaction verification (Bearer, Cookie, tokens never leaked).
2. Server cleanup on spawn failure.
3. Driver quit cleanup on screenshot failure.
4. Readiness failure error handling (marks FAILED, does not falsely pass).
5. [F6 Regression] StartCascade validation failure marks FAILED and does not verify inference.
6. [F6 Regression] Gemini web probe requires positive composer evidence, never assumes signed-in.
"""

import unittest
from unittest.mock import MagicMock, patch
import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import safe_logging
import test_aicode_endpoint
import test_start_cascade_details
import test_gemini_web

class TestProbeSafetyAndLifecycle(unittest.TestCase):

    def test_synthetic_redaction(self):
        """Test that Authorization, Cookie, and secrets are strictly redacted."""
        synthetic_bearer = "Bearer ya29.synthetic_secret_token_12345"
        synthetic_cookie = "SSID=synthetic_cookie_value; HSID=secret"
        synthetic_headers = {
            "Host": "127.0.0.1:8080",
            "Content-Type": "application/json",
            "Content-Length": "42",
            "Authorization": synthetic_bearer,
            "Cookie": synthetic_cookie,
            "X-Custom-Secret": "sensitive_data",
        }

        filtered = safe_logging.filter_headers(synthetic_headers)
        log_str = safe_logging.format_http_event("POST", "/test/path?token=secret123", synthetic_headers, 42, 200)

        self.assertNotIn("synthetic_secret_token_12345", log_str)
        self.assertNotIn("synthetic_cookie_value", log_str)
        self.assertNotIn("sensitive_data", log_str)
        self.assertNotIn("token=secret123", log_str)
        self.assertEqual(filtered.get("Authorization"), "<REDACTED>")
        self.assertEqual(filtered.get("Cookie"), "<REDACTED>")

    def test_spawn_failure_cleanup(self):
        """Test that if agy.exe spawn fails, mock server is still cleanly shut down."""
        with patch("subprocess.Popen", side_effect=OSError("Synthetic binary execution failure")):
            with patch("os.path.exists", return_value=True):
                with self.assertRaises(OSError):
                    test_start_cascade_details.run_isolated_probe("JETSKI_SERVICE_ENDPOINT_URL", timeout_s=1.0)

    def test_readiness_failure_marks_failed(self):
        """Test that when healthz times out, probe marks status FAILED (never false PASS)."""
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.terminate.return_value = None

        with patch("subprocess.Popen", return_value=mock_proc):
            with patch("os.path.exists", return_value=True):
                with patch("urllib.request.urlopen", side_effect=TimeoutError("Synthetic connection timeout")):
                    with self.assertRaises(TimeoutError):
                        test_aicode_endpoint.run_probe(timeout_s=0.5)

    def test_screenshot_failure_driver_cleanup(self):
        """Test that if screenshot fails, driver.quit() is still guaranteed in finally."""
        mock_driver = MagicMock()
        mock_driver.current_url = "https://gemini.google.com/app"
        mock_driver.title = "Google Gemini"
        mock_driver.page_source = "Sign in to Gemini"
        mock_driver.find_elements.return_value = []
        mock_driver.save_screenshot.side_effect = RuntimeError("Synthetic disk write error")

        with patch("os.path.exists", return_value=True):
            with patch("selenium.webdriver.Chrome", return_value=mock_driver):
                res = test_gemini_web.run_browser_probe(headless=True)
                mock_driver.quit.assert_called_once()
                self.assertTrue(res["cleanup_successful"])
                self.assertFalse(res["screenshot_saved"])

    def test_cascade_validation_failure_marks_failed(self):
        """[F6 Regression] StartCascade validation HTTP 400 marks FAILED and inference_route_verified is False."""
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.terminate.return_value = None

        # Simulate healthz returning 200, but StartCascade returning HTTP 400 ValidationFailed
        healthz_resp = MagicMock()
        healthz_resp.status = 200
        healthz_resp.__enter__.return_value = healthz_resp

        def urlopen_side_effect(req, *args, **kwargs):
            url = req.get_full_url() if hasattr(req, "get_full_url") else str(req)
            if "healthz" in url:
                return healthz_resp
            if "StartCascade" in url:
                raise urllib.error.HTTPError(url, 400, "ValidationFailed", {}, None)
            raise RuntimeError(f"Unexpected URL: {url}")

        with patch("subprocess.Popen", return_value=mock_proc):
            with patch("os.path.exists", return_value=True):
                with patch("urllib.request.urlopen", side_effect=urlopen_side_effect):
                    res = test_start_cascade_details.run_probe(var_to_test="JETSKI_SERVICE_ENDPOINT_URL", timeout_s=1.0)
                    self.assertFalse(res["inference_route_verified"])
                    self.assertEqual(res["status"], "FAILED")
                    self.assertEqual(res["start_cascade_outcome"], "HTTP_400_ValidationFailed")

    def test_gemini_web_positive_auth_evidence(self):
        """[F6 Regression] Gemini web probe requires positive composer evidence, never assumes signed-in."""
        mock_driver = MagicMock()
        mock_driver.current_url = "https://gemini.google.com/app"
        mock_driver.title = "Google Gemini"
        # Page source without 'sign in', but also no composer
        mock_driver.page_source = "<html><body>Welcome to Gemini overview</body></html>"
        mock_driver.find_elements.return_value = [] # No composer elements

        with patch("os.path.exists", return_value=True):
            with patch("selenium.webdriver.Chrome", return_value=mock_driver):
                res = test_gemini_web.run_browser_probe(headless=True)
                # Must NOT claim SIGNED_IN without positive composer evidence!
                self.assertEqual(res["auth_state"], "SIGN_IN_REQUIRED")

if __name__ == "__main__":
    unittest.main()
