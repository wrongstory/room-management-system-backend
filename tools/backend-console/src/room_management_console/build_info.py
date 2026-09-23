from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from . import __version__

SOURCE_SHA: Final = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class BuildInfo:
    version: str
    source_sha: str | None
    verified: bool

    @property
    def display_label(self) -> str:
        if self.verified and self.source_sha is not None:
            source = self.source_sha[:12]
        elif getattr(sys, "frozen", False):
            source = "UNVERIFIED"
        else:
            source = "DEVELOPMENT"
        return f"앱 버전: {self.version} | SOURCE: {source}"


def default_manifest_path() -> Path:
    root = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path.cwd()
    return root / "build-info.json"


def load_build_info(path: Path | None = None) -> BuildInfo:
    manifest_path = path or default_manifest_path()
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return BuildInfo(version=__version__, source_sha=None, verified=False)

    if not isinstance(value, dict):
        return BuildInfo(version=__version__, source_sha=None, verified=False)
    version = value.get("appVersion")
    source_sha = value.get("sourceSha")
    if (
        version != __version__
        or not isinstance(source_sha, str)
        or not SOURCE_SHA.fullmatch(source_sha)
    ):
        return BuildInfo(version=__version__, source_sha=None, verified=False)
    return BuildInfo(version=version, source_sha=source_sha, verified=True)
