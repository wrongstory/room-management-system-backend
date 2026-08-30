from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from .models import Environment

PROJECT_REF_PATTERN = re.compile(r"^[a-z0-9]{8,40}$")
LOCAL_HOSTS = {"127.0.0.1", "localhost"}


@dataclass(frozen=True, slots=True)
class AppConfig:
    environment: Environment
    project_ref: str
    supabase_url: str
    publishable_key: str = field(repr=False)
    inactivity_minutes: int = 15

    @property
    def api_base_url(self) -> str:
        return f"{self.supabase_url}/functions/v1/api"

    @property
    def auth_base_url(self) -> str:
        return f"{self.supabase_url}/auth/v1"

    @property
    def environment_label(self) -> str:
        return f"환경: {self.environment.upper()} | PROJECT: {self.project_ref}"


def _required_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} 설정이 필요합니다.")
    return value.strip()


def load_config(path: Path) -> AppConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("설정 파일을 읽을 수 없습니다.") from error
    if not isinstance(raw, dict):
        raise ValueError("설정 파일은 JSON object여야 합니다.")

    environment = _required_string(raw, "environment")
    if environment not in {"production", "recovery", "local"}:
        raise ValueError("environment는 production, recovery, local 중 하나여야 합니다.")
    project_ref = _required_string(raw, "projectRef").lower()
    supabase_url = _required_string(raw, "supabaseUrl").rstrip("/")
    publishable_key = _required_string(raw, "publishableKey")
    inactivity = raw.get("inactivityMinutes", 15)
    if not isinstance(inactivity, int) or not 5 <= inactivity <= 120:
        raise ValueError("inactivityMinutes는 5~120 사이 정수여야 합니다.")
    if len(publishable_key) < 20 or any(character.isspace() for character in publishable_key):
        raise ValueError("publishableKey 형식이 올바르지 않습니다.")

    parsed = urlsplit(supabase_url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Supabase URL에는 자격증명, query, fragment를 넣을 수 없습니다.")
    if parsed.path not in {"", "/"}:
        raise ValueError("Supabase URL에는 path를 넣을 수 없습니다.")

    if environment == "local":
        if parsed.scheme != "http" or parsed.hostname not in LOCAL_HOSTS:
            raise ValueError("local 환경은 http://127.0.0.1 또는 localhost만 허용합니다.")
        if project_ref != "local":
            raise ValueError("local 환경의 projectRef는 local이어야 합니다.")
    else:
        if parsed.scheme != "https" or parsed.hostname != f"{project_ref}.supabase.co":
            raise ValueError("hosted 환경 URL과 projectRef가 일치해야 합니다.")
        if not PROJECT_REF_PATTERN.fullmatch(project_ref):
            raise ValueError("projectRef 형식이 올바르지 않습니다.")

    return AppConfig(
        environment=cast(Environment, environment),
        project_ref=project_ref,
        supabase_url=supabase_url,
        publishable_key=publishable_key,
        inactivity_minutes=inactivity,
    )
