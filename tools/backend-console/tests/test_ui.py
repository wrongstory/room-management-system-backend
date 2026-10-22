from __future__ import annotations

import httpx
import pytest
from PySide6.QtCore import QCoreApplication, QThread, Slot
from PySide6.QtWidgets import QDialog, QMessageBox
from pytestqt.qtbot import QtBot
from shiboken6 import delete

import room_management_console.ui as ui_module
from room_management_console.api_client import ApiError, BackendApiClient
from room_management_console.approved_targets import APPROVED_HOSTED_TARGETS
from room_management_console.build_info import BuildInfo
from room_management_console.config import AppConfig
from room_management_console.models import Account
from room_management_console.readonly_db import ReadonlyQueryResult
from room_management_console.ui import (
    AccountsPage,
    ActivityPage,
    CreateAccountDialog,
    LoginDialog,
    ReadonlyDatabasePage,
)
from room_management_console.worker import Worker

RECOVERY_TARGET = APPROVED_HOSTED_TARGETS["recovery"]


@pytest.mark.parametrize("kind", ["login", "create"])
@pytest.mark.parametrize("fails", [False, True])
def test_dialog_destroyed_before_worker_result_has_no_late_widget_callback(
    qtbot: QtBot, monkeypatch: pytest.MonkeyPatch, kind: str, fails: bool
) -> None:
    pending: list[Worker] = []

    class DeferredPool:
        def start(self, worker: Worker) -> None:
            pending.append(worker)

    def task(*args: object, **kwargs: object) -> None:
        if fails:
            raise ApiError(status_code=503, code="TEST_UNAVAILABLE", message="synthetic")

    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda _: httpx.Response(500))
    )
    monkeypatch.setattr(client, "login", task)
    monkeypatch.setattr(client, "create_account", task)
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Yes)
    dialog: LoginDialog | CreateAccountDialog
    if kind == "login":
        dialog = LoginDialog(config(), client)
        dialog.password.setText("synthetic-password")
    else:
        dialog = CreateAccountDialog(client, None)
        dialog.display_name.setText("합성 계정")
        dialog.phone.setText("01000000000")
    monkeypatch.setattr(dialog, "_pool", DeferredPool())
    try:
        dialog._submit()
        assert len(pending) == 1
    finally:
        delete(dialog)
    # Deliver a real Worker result after the C++ receiver has been destroyed.
    # pytest-qt must see no exception from a dangling Python widget callback.
    pending[0].run()
    qtbot.wait(1)


@pytest.mark.parametrize("kind", ["login", "create"])
@pytest.mark.parametrize("fails", [False, True])
def test_dialog_worker_callbacks_are_bound_to_gui_thread(
    qtbot: QtBot, monkeypatch: pytest.MonkeyPatch, kind: str, fails: bool
) -> None:
    events: list[tuple[str, bool]] = []
    app = QCoreApplication.instance()
    assert app is not None

    def record(name: str) -> None:
        events.append((name, QThread.currentThread() == app.thread()))

    class LoginProbe(LoginDialog):
        @Slot(object)
        def _logged_in(self, _actor: object) -> None:
            record("success")

        @Slot(object)
        def _failed(self, error: object) -> None:
            record("error")

        @Slot()
        def _finished(self) -> None:
            record("finished")
            super()._finished()

    class CreateProbe(CreateAccountDialog):
        @Slot(object)
        def _created(self, result: object) -> None:
            record("success")

        @Slot(object)
        def _failed(self, error: object) -> None:
            record("error")

        @Slot()
        def _finished(self) -> None:
            record("finished")
            super()._finished()

    def task(*args: object, **kwargs: object) -> object:
        assert QThread.currentThread() != app.thread()
        if fails:
            raise ApiError(status_code=503, code="TEST_UNAVAILABLE", message="synthetic")
        return object()

    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda _: httpx.Response(500))
    )
    monkeypatch.setattr(client, "login", task)
    monkeypatch.setattr(client, "create_account", task)
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Yes)
    dialog: LoginProbe | CreateProbe
    if kind == "login":
        dialog = LoginProbe(config(), client)
        dialog.password.setText("synthetic-password")
    else:
        dialog = CreateProbe(client, None)
        dialog.display_name.setText("합성 계정")
        dialog.phone.setText("01000000000")
    qtbot.addWidget(dialog)
    dialog._submit()
    try:
        qtbot.waitUntil(lambda: len(events) == 2)
    except Exception:
        pytest.fail(f"Missing queued callbacks: {events!r}")
    assert events == [("error" if fails else "success", True), ("finished", True)]
    assert dialog.buttons.isEnabled()
    assert dialog._worker is None


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
    dialog = LoginDialog(config(), client, BuildInfo("0.1.0", "a" * 40, True))
    qtbot.addWidget(dialog)
    assert dialog.environment_label.text() == (
        f"환경: RECOVERY | PROJECT: {RECOVERY_TARGET.project_ref}"
    )
    assert dialog.build_label.text() == "앱 버전: 0.1.0 | SOURCE: aaaaaaaaaaaa"
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


def test_hosted_readonly_page_is_disabled_by_default(qtbot: QtBot) -> None:
    page = ReadonlyDatabasePage(config())
    qtbot.addWidget(page)

    assert not page.run_button.isEnabled()
    assert "HOSTED_DIRECT_DB_NOT_APPROVED" in page.status_label.text()
    assert page.db_user.text() == f"rms_diagnostic.{RECOVERY_TARGET.project_ref}"

    page._finished()

    assert not page.run_button.isEnabled()


def test_hosted_readonly_page_clears_password_and_renders_bounded_result(
    qtbot: QtBot, monkeypatch: pytest.MonkeyPatch
) -> None:
    enabled_config = AppConfig(
        environment="recovery",
        project_ref=RECOVERY_TARGET.project_ref,
        supabase_url=RECOVERY_TARGET.supabase_url,
        publishable_key="sb_publishable_example_only_1234567890",
        enable_hosted_readonly_db=True,
    )

    class FakeExecutor:
        def __init__(self, _factory: object) -> None:
            pass

        def execute(self, source: str) -> ReadonlyQueryResult:
            assert source == "SELECT * FROM public.diagnostic_system_summary"
            return ReadonlyQueryResult(
                columns=("room_count",),
                rows=((121,),),
                elapsed_ms=7,
                response_bytes=32,
            )

        def cancel(self) -> bool:
            return True

    monkeypatch.setattr(ui_module, "ReadonlyQueryExecutor", FakeExecutor)
    page = ReadonlyDatabasePage(enabled_config)
    qtbot.addWidget(page)
    page.pooler_host.setText("aws-0-ap-northeast-2.pooler.supabase.com")
    page.project_confirmation.setText(RECOVERY_TARGET.project_ref)
    page.db_password.setText("runtime-only-password")

    page.run_query()

    assert page.db_password.text() == ""
    qtbot.waitUntil(lambda: page.result_table.rowCount() == 1)
    result_item = page.result_table.item(0, 0)
    assert result_item is not None
    assert result_item.text() == "121"
    assert page.result_meta.text() == "1행 / 32 bytes / 7 ms"


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
                                "GOOGLE_DRIVE_CLIENT_ID",
                                "GOOGLE_DRIVE_CLIENT_SECRET",
                                "GOOGLE_DRIVE_REFRESH_TOKEN",
                                "GOOGLE_DRIVE_ROOT_FOLDER_ID",
                                "PHOTO_PURGE_INVOKE_SECRET",
                                "PAYROLL_CURSOR_HMAC_SECRET",
                                "NOTIFICATION_CURSOR_HMAC_SECRET",
                                "WEB_PUSH_SUBSCRIPTION_KEY_BASE64",
                                "WEB_PUSH_SUBSCRIPTION_KEY_VERSION",
                                "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON",
                                "WEB_PUSH_BINDING_DIGEST_SECRET",
                                "VAPID_SUBJECT",
                                "VAPID_CURRENT_KEY_VERSION",
                                "VAPID_PUBLIC_KEY",
                                "VAPID_PUBLIC_KEYRING_JSON",
                                "VAPID_PRIVATE_KEY",
                                "VAPID_KEYRING_JSON",
                                "NOTIFICATION_DELIVERY_INVOKE_SECRET",
                                "ROOM_PIN_KEY_BASE64",
                                "ROOM_PIN_KEY_VERSION",
                                "ROOM_PIN_KEYRING_JSON",
                                "ROOM_PIN_SHEET_SYNC_INVOKE_SECRET",
                                "GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL",
                                "GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY",
                                "GOOGLE_SHEETS_SPREADSHEET_ID",
                                "GOOGLE_SHEETS_ROOM_PIN_TAB",
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


def test_activity_page_labels_security_events_separately_from_domain_audit(
    qtbot: QtBot,
) -> None:
    client = BackendApiClient(
        config(), transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )
    page = ActivityPage(client)
    qtbot.addWidget(page)
    page._render(
        {
            "events": [
                {
                    "recordedAt": "2026-08-31T12:00:00Z",
                    "category": "authorization",
                    "eventType": "authorization.denied",
                    "outcome": "denied",
                    "actorProfileId": "00000000-0000-4000-8000-000000000001",
                    "actorRole": "maid",
                    "reasonCode": "ADMIN_REQUIRED",
                    "summary": {},
                }
            ],
            "nextCursor": None,
        }
    )

    category_header = page.table.horizontalHeaderItem(1)
    event_item = page.table.item(0, 2)
    actor_item = page.table.item(0, 4)
    assert category_header is not None and category_header.text() == "범주"
    assert event_item is not None and event_item.text() == "authorization.denied"
    assert actor_item is not None and actor_item.text().endswith(" / maid")
