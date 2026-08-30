from __future__ import annotations

import json
from pathlib import Path

import pytest

from room_management_console.config import load_config


def write_config(path: Path, **overrides: object) -> Path:
    value: dict[str, object] = {
        "environment": "production",
        "projectRef": "abcdefgh",
        "supabaseUrl": "https://abcdefgh.supabase.co",
        "publishableKey": "sb_publishable_example_only_1234567890",
        "inactivityMinutes": 15,
    }
    value.update(overrides)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def test_hosted_environment_and_project_ref_must_match(tmp_path: Path) -> None:
    path = write_config(tmp_path / "config.json", supabaseUrl="https://wrongref.supabase.co")
    with pytest.raises(ValueError, match="일치"):
        load_config(path)


def test_local_environment_is_loopback_only(tmp_path: Path) -> None:
    path = write_config(
        tmp_path / "config.json",
        environment="local",
        projectRef="local",
        supabaseUrl="http://127.0.0.1:54321",
    )
    config = load_config(path)
    assert config.api_base_url == "http://127.0.0.1:54321/functions/v1/api"
    assert config.environment_label == "환경: LOCAL | PROJECT: local"


def test_credentials_cannot_be_embedded_in_url(tmp_path: Path) -> None:
    path = write_config(
        tmp_path / "config.json",
        supabaseUrl="https://user:password@abcdefgh.supabase.co",
    )
    with pytest.raises(ValueError, match="자격증명"):
        load_config(path)
