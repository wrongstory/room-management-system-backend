from __future__ import annotations

import copy
import json
import runpy
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
CHECK = runpy.run_path(
    str(ROOT / "tools/backend-console/scripts/check_business_openapi_codegen.py")
)["check_post_approval_contract"]


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    npm = shutil.which("npm")
    assert npm is not None
    subprocess.run([npm, "run", "openapi:export:full"], cwd=ROOT, check=True)  # noqa: S603
    result: dict[str, Any] = json.loads(
        (ROOT / ".tmp/full-openapi.json").read_text(encoding="utf-8")
    )
    return result


def test_deployed_contract(document: dict[str, Any]) -> None:
    CHECK(document)


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "replacement"])
def test_rejects_auth_error_code_drift(document: dict[str, Any], mutation: str) -> None:
    candidate = copy.deepcopy(document)
    codes = candidate["components"]["schemas"]["ErrorCode"]["enum"]
    if mutation == "duplicate":
        codes.append("AUTH_CONTEXT_UNAVAILABLE")
    else:
        codes.remove("AUTH_CONTEXT_UNAVAILABLE")
        if mutation == "replacement":
            codes.append("UNREVIEWED_ERROR")
    with pytest.raises(RuntimeError, match="#442"):
        CHECK(candidate)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("x-implementation-status", "source-registered-not-deployed"),
        ("x-implementation-status", None),
        ("x-deployed-release", "v9.9.9"),
        ("x-deployed-release", None),
        ("security", []),
        ("x-required-roles", ["maid"]),
    ],
)
def test_rejects_metadata_and_authority_drift(
    document: dict[str, Any], field: str, value: Any
) -> None:
    candidate = copy.deepcopy(document)
    path = "/v1/cleaning-history/submissions/{sourceSubmissionId}/supplemental-room-issues/source"
    candidate["paths"][path]["get"][field] = value
    with pytest.raises(RuntimeError, match="getPostApprovalRoomIssueSource"):
        CHECK(candidate)
