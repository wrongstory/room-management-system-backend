from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def main() -> None:
    console_root = Path(__file__).resolve().parents[1]
    repository_root = console_root.parents[1]
    source = repository_root / ".tmp" / "backend-console-openapi.json"
    generated_project = console_root / ".tmp" / "generated"
    destination = console_root / "src" / "room_management_console" / "generated"
    npm = shutil.which("npm")
    uv = shutil.which("uv")
    if not npm or not uv:
        raise RuntimeError("npm과 uv 실행 파일이 PATH에 필요합니다.")

    subprocess.run(  # noqa: S603
        [npm, "run", "console:openapi:export"],
        cwd=repository_root,
        check=True,
    )
    generated_project.parent.mkdir(parents=True, exist_ok=True)
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
            str(generated_project),
            "--overwrite",
        ],
        cwd=console_root,
        check=True,
    )
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(generated_project / "generated", destination)
    print(f"generated client: {destination}")


if __name__ == "__main__":
    main()
