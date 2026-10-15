"""
Safe logging and redaction utilities for G0 probes.
Enforces strict metadata allowlisting: never logs credentials, bearer tokens,
cookies, query secrets, or raw request/response payloads.
"""

from typing import Dict, Any, Optional

ALLOWED_HEADER_KEYS = {
    "content-type",
    "content-length",
    "host",
    "user-agent",
    "accept",
    "accept-encoding",
    "x-codeium-csrf-token",  # public local hub token, masked
}

SENSITIVE_PATTERNS = [
    "authorization",
    "bearer",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "key",
    "secret",
    "token",
    "password",
]

def sanitize_header_value(key: str, val: str) -> str:
    key_lower = key.lower()
    for s in SENSITIVE_PATTERNS:
        if s in key_lower:
            return "<REDACTED>"
    return val

def filter_headers(headers: Dict[str, str]) -> Dict[str, str]:
    """
    Returns only allowlisted headers with all sensitive values masked.
    """
    safe: Dict[str, str] = {}
    for k, v in headers.items():
        k_lower = k.lower()
        if k_lower in ALLOWED_HEADER_KEYS:
            safe[k] = sanitize_header_value(k, v)
        elif any(s in k_lower for s in SENSITIVE_PATTERNS):
            safe[k] = "<REDACTED>"
    return safe

def sanitize_path(path: str) -> str:
    """
    Strips sensitive query parameters from URLs and returns safe path.
    """
    if "?" not in path:
        return path
    base, query = path.split("?", 1)
    # Strip query entirely to prevent token leakage in URL params
    return f"{base}?query_redacted"

def format_http_event(method: str, path: str, headers: Dict[str, str], body_len: int, status: Optional[int] = None) -> str:
    """
    Formats a log message using strictly allowlisted metadata.
    """
    safe_path = sanitize_path(path)
    safe_headers = filter_headers(headers)
    status_str = f" -> {status}" if status is not None else ""
    return (
        f"[{method}] {safe_path}{status_str} | "
        f"body_bytes={body_len} | headers={safe_headers}"
    )

class SafeProbeLogger:
    @staticmethod
    def log_request(method: str, path: str, headers: Any, body: Optional[bytes] = None, status: Optional[int] = None):
        header_dict = dict(headers) if headers else {}
        body_len = len(body) if body else 0
        msg = format_http_event(method, path, header_dict, body_len, status)
        print(f"[SafeProbeLogger] {msg}")


