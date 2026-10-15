#!/usr/bin/env python3
"""
Probe: test_gemini_web.py
Tests Chrome launch with isolated profile to inspect Gemini Web availability.
Guarantees driver cleanup in finally block, structured result, and no credential capture.
"""

import os
import sys
import time
import json
from typing import Dict, Any

def run_browser_probe(
    profile_dir: str = r"C:\Users\vhc\.gemini\gemini_web_probe_profile",
    chrome_path: str = r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    headless: bool = False,
    timeout_s: float = 15.0
) -> Dict[str, Any]:
    os.makedirs(profile_dir, exist_ok=True)
    
    result: Dict[str, Any] = {
        "test": "test_gemini_web",
        "status": "FAILED",
        "browser_launched": False,
        "navigated_to_gemini": False,
        "page_title": "",
        "current_url": "",
        "auth_state": "unknown",
        "mcp_custom_apps_capability": "NOT_TESTED",
        "screenshot_saved": False,
        "cleanup_successful": False,
    }

    if not os.path.exists(chrome_path):
        result["status"] = "NOT_TESTED"
        result["reason"] = f"Chrome binary not found at {chrome_path}"
        return result

    driver = None
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options

        chrome_options = Options()
        chrome_options.add_argument(f"--user-data-dir={profile_dir}")
        chrome_options.binary_location = chrome_path
        if headless:
            chrome_options.add_argument("--headless=new")
        chrome_options.add_argument("--disable-gpu")
        chrome_options.add_argument("--no-first-run")
        chrome_options.add_argument("--no-default-browser-check")

        print(f"[GeminiWebProbe] Launching Chrome with profile at {profile_dir}...")
        driver = webdriver.Chrome(options=chrome_options)
        result["browser_launched"] = True

        print("[GeminiWebProbe] Navigating to https://gemini.google.com/app ...")
        driver.get("https://gemini.google.com/app")
        time.sleep(3.0)

        result["current_url"] = driver.current_url
        result["page_title"] = driver.title
        result["navigated_to_gemini"] = ("gemini.google.com" in driver.current_url)

        # Check authentication using positive evidence [F6 regression fix]
        source = driver.page_source.lower()
        composer_found = False
        try:
            from selenium.webdriver.common.by import By
            composer_elements = driver.find_elements(By.CSS_SELECTOR, "rich-textarea, textarea, div[contenteditable='true'], div.ql-editor")
            composer_found = len(composer_elements) > 0
        except Exception:
            composer_found = False

        if "accounts.google.com" in driver.current_url or "sign in" in source or "đăng nhập" in source:
            result["auth_state"] = "SIGN_IN_REQUIRED"
            result["mcp_custom_apps_capability"] = "NOT_TESTED (Requires signed-in personal Google account)"
        elif composer_found:
            result["auth_state"] = "SIGNED_IN"
            result["mcp_custom_apps_capability"] = "NOT_TESTED (Manual MCP configuration inspection required)"
        else:
            result["auth_state"] = "SIGN_IN_REQUIRED"
            result["mcp_custom_apps_capability"] = "NOT_TESTED (Composer not detected; authentication required)"

        # Safe screenshot saving
        try:
            screenshot_path = os.path.join(profile_dir, "gemini_probe_snapshot.png")
            driver.save_screenshot(screenshot_path)
            result["screenshot_saved"] = True
            print(f"[GeminiWebProbe] Saved snapshot to {screenshot_path}")
        except Exception as e:
            print(f"[GeminiWebProbe] Warning: Screenshot capture failed: {e}")

        # The probe itself succeeded in opening the browser and establishing the baseline state
        result["status"] = "PASSED"

    except Exception as e:
        result["error"] = f"{type(e).__name__}: {str(e)}"
        print(f"[GeminiWebProbe] Error encountered: {result['error']}")
    finally:
        if driver is not None:
            try:
                driver.quit()
                result["cleanup_successful"] = True
                print("[GeminiWebProbe] Browser closed cleanly in finally.")
            except Exception as e:
                result["cleanup_successful"] = False
                print(f"[GeminiWebProbe] Error during driver.quit: {e}")

    return result

if __name__ == "__main__":
    headless_flag = "--headless" in sys.argv
    res = run_browser_probe(headless=headless_flag)
    print(json.dumps(res, indent=2))
    if res["status"] != "PASSED":
        sys.exit(1)
    sys.exit(0)
