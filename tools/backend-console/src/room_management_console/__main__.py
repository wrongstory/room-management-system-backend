from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QMessageBox

from . import __version__
from .api_client import BackendApiClient
from .config import load_config
from .ui import LoginDialog, MainWindow


def arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CASTLE THE ART 백엔드 운영 콘솔")
    default_root = (
        Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path.cwd()
    )
    parser.add_argument("--config", type=Path, default=default_root / "config.json")
    parser.add_argument("--version", action="version", version=__version__)
    return parser.parse_args(argv)


def main() -> int:
    options = arguments(sys.argv[1:])
    application = QApplication(sys.argv)
    application.setQuitOnLastWindowClosed(False)
    application.setApplicationName("CASTLE THE ART Backend Console")
    application.setApplicationVersion(__version__)
    try:
        config = load_config(options.config.resolve())
    except ValueError as error:
        QMessageBox.critical(None, "설정 오류", str(error))
        return 2

    client = BackendApiClient(config)

    windows: dict[str, MainWindow] = {}

    def show_login() -> None:
        login = LoginDialog(config, client)
        if login.exec() != LoginDialog.DialogCode.Accepted:
            application.quit()
            return
        window = MainWindow(config, client)
        windows["main"] = window
        window.locked.connect(lambda: QTimer.singleShot(0, show_login))
        window.show()

    QTimer.singleShot(0, show_login)
    return application.exec()


if __name__ == "__main__":
    raise SystemExit(main())
