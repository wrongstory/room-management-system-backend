from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

SENSITIVE_KEYS = {
    "access_token",
    "accesstoken",
    "authorization",
    "currentpassword",
    "newpassword",
    "password",
    "phone",
    "refreshtoken",
    "refresh_token",
    "temporarypassword",
    "token",
}
BEARER_PATTERN = re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+")
JWT_PATTERN = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
PHONE_PATTERN = re.compile(r"(?<!\d)01[016789]-?\d{3,4}-?\d{4}(?!\d)")


def redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if str(key).lower() in SENSITIVE_KEYS else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    if isinstance(value, str):
        return redact_text(value)
    return value


def redact_text(value: str) -> str:
    redacted = BEARER_PATTERN.sub("Bearer [REDACTED]", value)
    redacted = JWT_PATTERN.sub("[REDACTED_TOKEN]", redacted)
    return PHONE_PATTERN.sub("[REDACTED_PHONE]", redacted)
