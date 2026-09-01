from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from room_management_console.approved_targets import APPROVED_HOSTED_TARGETS, HostedEnvironment
from room_management_console.config import load_config


def write_config(path: Path, **overrides: object) -> Path:
    production = APPROVED_HOSTED_TARGETS["production"]
    value: dict[str, object] = {
        "environment": "production",
        "projectRef": production.project_ref,
        "supabaseUrl": production.supabase_url,
        "publishableKey": "sb_publishable_example_only_1234567890",
        "inactivityMinutes": 15,
    }
    value.update(overrides)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def test_matching_but_unapproved_production_project_is_rejected(tmp_path: Path) -> None:
    path = write_config(
        tmp_path / "config.json",
        projectRef="unapprovedprojectref00",
        supabaseUrl="https://unapprovedprojectref00.supabase.co",
    )
    with pytest.raises(ValueError, match="승인되지 않은"):
        load_config(path)


@pytest.mark.parametrize("environment", ["production", "recovery"])
def test_approved_hosted_targets_are_accepted(tmp_path: Path, environment: str) -> None:
    target = APPROVED_HOSTED_TARGETS[cast(HostedEnvironment, environment)]
    path = write_config(
        tmp_path / f"{environment}.json",
        environment=environment,
        projectRef=target.project_ref,
        supabaseUrl=target.supabase_url,
    )
    config = load_config(path)
    assert config.project_ref == target.project_ref
    assert config.supabase_url == target.supabase_url


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
