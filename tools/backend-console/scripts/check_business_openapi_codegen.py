from __future__ import annotations

import compileall
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def main() -> None:
    console_root = Path(__file__).resolve().parents[1]
    repository_root = console_root.parents[1]
    npm = shutil.which("npm")
    uv = shutil.which("uv")
    if not npm or not uv:
        raise RuntimeError("npm과 uv 실행 파일이 PATH에 필요합니다.")

    subprocess.run(  # noqa: S603
        [npm, "run", "openapi:export:full"],
        cwd=repository_root,
        check=True,
    )
    source = repository_root / ".tmp" / "full-openapi.json"
    document = json.loads(source.read_text(encoding="utf-8"))
    paths = document.get("paths")
    if not isinstance(paths, dict) or len(paths) != 77:
        raise RuntimeError("전체 source OpenAPI path 수가 77이 아닙니다.")
    methods = {"get", "post", "put", "patch", "delete"}
    operation_count = sum(
        1
        for path_item in paths.values()
        if isinstance(path_item, dict)
        for method in path_item
        if method in methods
    )
    if operation_count != 83:
        raise RuntimeError("전체 source OpenAPI operation 수가 83이 아닙니다.")
    with tempfile.TemporaryDirectory(prefix="payroll-openapi-codegen-") as temporary:
        destination = Path(temporary) / "generated-project"
        subprocess.run(  # noqa: S603
            [
                uv,
                "run",
                "--python",
                "3.12",
                "openapi-python-client",
                "generate",
                "--path",
                str(source),
                "--config",
                str(console_root / "openapi-python-client.yaml"),
                "--output-path",
                str(destination),
                "--overwrite",
            ],
            cwd=console_root,
            check=True,
        )
        package = destination / "generated"
        required = [
            package / "api" / "payroll" / "list_payroll_cycles.py",
            package / "api" / "payroll" / "list_payroll_entries.py",
            package / "api" / "payroll" / "start_payroll_cycle.py",
            package / "models" / "payroll_cycle.py",
            package / "models" / "payroll_item.py",
            package / "models" / "payroll_late_earning.py",
            package / "models" / "payroll_entries_envelope.py",
            package / "models" / "payroll_start_request.py",
            package / "models" / "payroll_status.py",
        ]
        missing = [str(path.relative_to(destination)) for path in required if not path.is_file()]
        if missing:
            raise RuntimeError(f"Payroll Python codegen 결과가 누락됐습니다: {', '.join(missing)}")
        if not compileall.compile_dir(package, quiet=1):
            raise RuntimeError("Payroll Python codegen 결과를 컴파일할 수 없습니다.")

    print("full OpenAPI payroll Python ephemeral codegen PASS")


if __name__ == "__main__":
    main()
