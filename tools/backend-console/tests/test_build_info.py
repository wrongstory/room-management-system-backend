from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from room_management_console import __version__
from room_management_console.build_info import load_build_info

SOURCE_SHA = "a" * 40


def test_load_build_info_accepts_exact_version_and_source_sha(tmp_path: Path) -> None:
    manifest = tmp_path / "build-info.json"
    manifest.write_text(
        json.dumps({"appVersion": __version__, "sourceSha": SOURCE_SHA}), encoding="utf-8"
    )

    build_info = load_build_info(manifest)

    assert build_info.verified is True
    assert build_info.source_sha == SOURCE_SHA
    assert build_info.display_label == f"앱 버전: {__version__} | SOURCE: {SOURCE_SHA[:12]}"


def test_load_build_info_marks_missing_manifest_unverified(tmp_path: Path) -> None:
    build_info = load_build_info(tmp_path / "missing.json")

    assert build_info.verified is False
    assert build_info.source_sha is None
    assert build_info.display_label == f"앱 버전: {__version__} | SOURCE: DEVELOPMENT"


def test_frozen_app_marks_missing_manifest_unverified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    build_info = load_build_info(tmp_path / "missing.json")

    assert build_info.display_label == f"앱 버전: {__version__} | SOURCE: UNVERIFIED"


def test_load_build_info_does_not_display_malformed_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "build-info.json"
    manifest.write_text(
        json.dumps({"appVersion": "unexpected", "sourceSha": "raw-secret-like-value"}),
        encoding="utf-8",
    )

    build_info = load_build_info(manifest)

    assert build_info.verified is False
    assert build_info.source_sha is None
    assert "raw-secret-like-value" not in build_info.display_label
