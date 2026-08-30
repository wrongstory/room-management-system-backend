from __future__ import annotations

import httpx
import pytest
from PySide6.QtWidgets import QDialog, QMessageBox
from pytestqt.qtbot import QtBot

from room_management_console.api_client import BackendApiClient
from room_management_console.config import AppConfig
from room_management_console.ui import CreateAccountDialog, LoginDialog


def config() -> AppConfig:
    return AppConfig(
        environment="recovery",
        project_ref="abcdefgh",
        supabase_url="https://abcdefgh.supabase.co",
        publishable_key="sb_publishable_example_only_1234567890",
    )


def test_login_always_displays_environment_and_project_ref(qtbot: QtBot) -> None:
    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )
    dialog = LoginDialog(config(), client)
    qtbot.addWidget(dialog)
    assert dialog.environment_label.text() == "환경: RECOVERY | PROJECT: abcdefgh"
    assert dialog.login_id.text() == "admin"
    assert dialog.login_id.isReadOnly()
    assert dialog.password.text() == ""


def test_login_password_field_does_not_echo_plain_text(qtbot: QtBot) -> None:
    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )
    dialog = LoginDialog(config(), client)
    qtbot.addWidget(dialog)
    assert dialog.password.echoMode() == dialog.password.EchoMode.Password


def test_create_account_clears_phone_before_network_result(
    qtbot: QtBot, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(
                200,
                json={
                    "accessToken": "access-token-value",
                    "refreshToken": "refresh-token-value",
                    "expiresIn": 3600,
                    "user": {
                        "authUserId": "00000000-0000-4000-8000-000000000001",
                        "profileId": "00000000-0000-4000-8000-000000000002",
                        "displayName": "개발자",
                        "role": "developer",
                        "mustChangePassword": False,
                    },
                },
            )
        return httpx.Response(
            201,
            json={
                "account": {
                    "id": "00000000-0000-4000-8000-000000000003",
                    "displayName": "운영 관리자",
                    "loginId": "operator",
                    "role": "admin",
                    "status": "active",
                    "phoneLastFour": "0000",
                    "mustChangePassword": True,
                    "failedLoginCount": 0,
                    "lockedUntil": None,
                    "createdAt": "2026-08-31T00:00:00Z",
                    "updatedAt": "2026-08-31T00:00:00Z",
                },
                "temporaryPassword": "0000",
            },
        )

    client = BackendApiClient(config(), transport=httpx.MockTransport(handler))
    client.login("admin", "not-a-real-password")
    dialog = CreateAccountDialog(client, None)
    qtbot.addWidget(dialog)
    dialog.display_name.setText("운영 관리자")
    dialog.phone.setText("01000000000")
    monkeypatch.setattr(
        QMessageBox,
        "question",
        lambda *args, **kwargs: QMessageBox.StandardButton.Yes,
    )
    monkeypatch.setattr(QMessageBox, "exec", lambda self: int(QMessageBox.StandardButton.Ok))
    dialog._submit()
    assert dialog.phone.text() == ""
    qtbot.waitUntil(lambda: dialog.result() == QDialog.DialogCode.Accepted)
