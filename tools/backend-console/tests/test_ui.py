from __future__ import annotations

import httpx
import pytest
from PySide6.QtWidgets import QDialog, QMessageBox
from pytestqt.qtbot import QtBot

from room_management_console.api_client import BackendApiClient
from room_management_console.approved_targets import APPROVED_HOSTED_TARGETS
from room_management_console.config import AppConfig
from room_management_console.models import Account
from room_management_console.ui import AccountsPage, CreateAccountDialog, LoginDialog

RECOVERY_TARGET = APPROVED_HOSTED_TARGETS["recovery"]


def config() -> AppConfig:
    return AppConfig(
        environment="recovery",
        project_ref=RECOVERY_TARGET.project_ref,
        supabase_url=RECOVERY_TARGET.supabase_url,
        publishable_key="sb_publishable_example_only_1234567890",
    )


def test_login_always_displays_environment_and_project_ref(qtbot: QtBot) -> None:
    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )
    dialog = LoginDialog(config(), client)
    qtbot.addWidget(dialog)
    assert dialog.environment_label.text() == (
        f"환경: RECOVERY | PROJECT: {RECOVERY_TARGET.project_ref}"
    )
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
        if request.url.path.endswith("/v1/developer/runtime-status"):
            return httpx.Response(
                200,
                json={
                    "runtime": {
                        "adapter": "supabase-edge",
                        "environment": "recovery",
                        "projectRef": RECOVERY_TARGET.project_ref,
                        "runtime": {"name": "deno", "version": "2.test"},
                        "source": {
                            "apiVersion": "0.2.0",
                            "expectedMigration": "developer_operations_projection",
                            "fastifyRollbackBaseline": "available",
                        },
                        "configuration": {
                            name: {"configured": False}
                            for name in (
                                "ACCOUNT_PHONE_PEPPER",
                                "CORS_ORIGINS",
                                "RESERVATION_GUEST_NAME_PEPPER",
                                "RESERVATION_PII_KEY_BASE64",
                                "RESERVATION_PII_KEYRING_JSON",
                                "RESERVATION_PII_KEY_VERSION",
                                "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
                                "SCHEDULER_INVOKE_SECRET",
                            )
                        },
                        "checkedAt": "2026-08-31T00:00:00Z",
                    }
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


def test_account_table_displays_transitional_statuses_without_enabling_status_change(
    qtbot: QtBot,
) -> None:
    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )
    page = AccountsPage(client)
    qtbot.addWidget(page)
    values = []
    for index, status in enumerate(("deactivation_pending", "upload_only"), start=1):
        values.append(
            Account.from_dict(
                {
                    "id": f"00000000-0000-4000-8000-00000000000{index}",
                    "displayName": f"전이 계정 {index}",
                    "loginId": f"transition-{index}",
                    "role": "maid",
                    "status": status,
                    "phoneLastFour": "0000",
                    "mustChangePassword": False,
                    "failedLoginCount": 0,
                    "lockedUntil": None,
                    "createdAt": "2026-08-31T00:00:00Z",
                    "updatedAt": "2026-08-31T00:00:00Z",
                }
            )
        )
    page._set_accounts(values)
    pending_item = page.table.item(0, 3)
    upload_only_item = page.table.item(1, 3)
    assert pending_item is not None and pending_item.text() == "deactivation_pending"
    assert upload_only_item is not None and upload_only_item.text() == "upload_only"
    page.table.selectRow(0)
    page._update_actions()
    assert not page.status_button.isEnabled()
