from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

SOURCE_SHA_LENGTH = 40


def verify_source(console_root: Path) -> None:
    required = [
        console_root / "uv.lock",
        console_root / "config.example.json",
        console_root / "src" / "room_management_console" / "__main__.py",
        console_root / "src" / "room_management_console" / "generated" / "client.py",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(f"패키징 필수 파일 누락: {', '.join(missing)}")
    if (console_root / "config.json").exists():
        print("주의: 로컬 config.json은 artifact에 포함하지 않습니다.")


def read_build_identity(console_root: Path) -> dict[str, str]:
    repository_root = console_root.parents[1]
    git_executable = shutil.which("git")
    if git_executable is None:
        raise RuntimeError("Git 실행 파일을 확인할 수 없습니다.")
    dirty_files = subprocess.run(  # noqa: S603
        [git_executable, "status", "--porcelain", "--untracked-files=all"],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if dirty_files:
        raise RuntimeError("변경 파일이 있는 작업 트리에서는 배포 artifact를 만들 수 없습니다.")
    source_sha = subprocess.run(  # noqa: S603
        [git_executable, "rev-parse", "HEAD"],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if len(source_sha) != SOURCE_SHA_LENGTH or any(
        character not in "0123456789abcdef" for character in source_sha
    ):
        raise RuntimeError("Git source SHA를 확인할 수 없습니다.")

    project = tomllib.loads((console_root / "pyproject.toml").read_text(encoding="utf-8"))
    version = project.get("project", {}).get("version")
    if not isinstance(version, str) or not version:
        raise RuntimeError("backend console version을 확인할 수 없습니다.")
    return {"appVersion": version, "sourceSha": source_sha}


def build(console_root: Path) -> Path:
    build_identity = read_build_identity(console_root)
    dist = console_root / "dist"
    build_dir = console_root / "build"
    python_root = Path(sys.executable).resolve().parent
    windows_root = Path(os.environ.get("SYSTEMROOT", r"C:\Windows"))
    build_environment = os.environ.copy()
    # Codex/문서 도구의 native DLL이 부모 PATH에 있어도 artifact에 섞이지 않게 고정한다.
    build_environment["PATH"] = os.pathsep.join(
        [
            str(python_root),
            str(python_root / "Scripts"),
            str(windows_root / "System32"),
            str(windows_root),
        ]
    )
    subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--windowed",
            "--onedir",
            "--name",
            "RoomManagementBackendConsole",
            "--paths",
            str(console_root / "src"),
            "--distpath",
            str(dist),
            "--workpath",
            str(build_dir),
            str(console_root / "scripts" / "launcher.py"),
        ],
        cwd=console_root,
        check=True,
        env=build_environment,
    )
    artifact_directory = dist / "RoomManagementBackendConsole"
    shutil.copy2(console_root / "config.example.json", artifact_directory / "config.example.json")
    (artifact_directory / "build-info.json").write_text(
        json.dumps(build_identity, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="ascii",
    )
    archive = Path(
        shutil.make_archive(
            str(dist / "RoomManagementBackendConsole-windows-x64"),
            "zip",
            root_dir=dist,
            base_dir=artifact_directory.name,
        )
    )
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(f"{archive.suffix}.sha256").write_text(
        f"{digest}  {archive.name}\n", encoding="ascii"
    )
    return archive


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-only", action="store_true")
    options = parser.parse_args()
    console_root = Path(__file__).resolve().parents[1]
    verify_source(console_root)
    if options.check_only:
        print("backend console package source check PASS")
        return
    artifact = build(console_root)
    print(f"artifact: {artifact}")


if __name__ == "__main__":
    main()
