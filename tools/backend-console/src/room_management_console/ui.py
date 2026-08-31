from __future__ import annotations

import html
import re
from collections.abc import Callable
from typing import Any, cast

from PySide6.QtCore import QEvent, QObject, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QAction, QCloseEvent
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from .api_client import ApiError, BackendApiClient
from .config import AppConfig
from .models import ACCOUNT_STATUS_TARGETS, Account, AccountStatusTarget
from .policies import account_action_policy
from .worker import Worker

REASON_CODE = re.compile(r"^[A-Z0-9_]{2,80}$")


def show_api_error(parent: QWidget, error: ApiError) -> None:
    detail = error.safe_summary()
    if error.retry_after:
        detail += f"\n{error.retry_after}초 후 다시 시도하세요."
    QMessageBox.warning(parent, "요청 실패", detail)


class LoginDialog(QDialog):
    def __init__(self, config: AppConfig, client: BackendApiClient) -> None:
        super().__init__()
        self._client = client
        self._pool = QThreadPool.globalInstance()
        self.setWindowTitle("CASTLE THE ART 백엔드 운영 콘솔 로그인")
        self.setMinimumWidth(440)

        layout = QVBoxLayout(self)
        self.environment_label = QLabel(config.environment_label)
        self.environment_label.setObjectName("environmentBanner")
        self.environment_label.setStyleSheet(
            "font-weight: 700; padding: 10px; background: #182230; color: white;"
        )
        layout.addWidget(self.environment_label)
        layout.addWidget(
            QLabel("비밀번호와 세션 토큰은 이 PC의 파일·레지스트리에 저장되지 않습니다.")
        )

        form = QFormLayout()
        self.login_id = QLineEdit("admin")
        self.login_id.setReadOnly(True)
        self.password = QLineEdit()
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.password.setMaxLength(72)
        form.addRow("Developer ID", self.login_id)
        form.addRow("비밀번호", self.password)
        layout.addLayout(form)

        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setText("로그인")
        self.buttons.accepted.connect(self._submit)
        self.buttons.rejected.connect(self.reject)
        layout.addWidget(self.buttons)

    def _submit(self) -> None:
        password = self.password.text()
        self.password.clear()
        if not password:
            QMessageBox.information(self, "입력 확인", "비밀번호를 입력하세요.")
            return
        self.buttons.setEnabled(False)
        worker = Worker(lambda: self._client.login("admin", password))
        worker.signals.succeeded.connect(lambda _actor: self.accept())
        worker.signals.failed.connect(lambda error: show_api_error(self, cast(ApiError, error)))
        worker.signals.finished.connect(lambda: self.buttons.setEnabled(True))
        self._pool.start(worker)


class CreateAccountDialog(QDialog):
    account_created = Signal(object, str)

    def __init__(self, client: BackendApiClient, parent: QWidget | None) -> None:
        super().__init__(parent)
        self._client = client
        self._pool = QThreadPool.globalInstance()
        self.setWindowTitle("business admin / maid 생성")
        self.setMinimumWidth(460)

        layout = QVBoxLayout(self)
        layout.addWidget(
            QLabel("휴대전화 원문은 요청 직후 입력창에서 지워지며 응답·로그에 저장되지 않습니다.")
        )
        form = QFormLayout()
        self.display_name = QLineEdit()
        self.display_name.setMaxLength(40)
        self.role = QComboBox()
        self.role.addItem("최상위 관리자 (business admin)", "admin")
        self.role.addItem("메이드", "maid")
        self.phone = QLineEdit()
        self.phone.setPlaceholderText("01012345678")
        self.phone.setMaxLength(30)
        form.addRow("표시 이름", self.display_name)
        form.addRow("역할", self.role)
        form.addRow("휴대전화", self.phone)
        layout.addLayout(form)

        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        self.buttons.button(QDialogButtonBox.StandardButton.Save).setText("생성")
        self.buttons.accepted.connect(self._submit)
        self.buttons.rejected.connect(self.reject)
        layout.addWidget(self.buttons)

    def _submit(self) -> None:
        display_name = self.display_name.text().strip()
        role = str(self.role.currentData())
        phone = self.phone.text().strip()
        self.phone.clear()
        if len(display_name) < 2 or not phone:
            QMessageBox.information(self, "입력 확인", "표시 이름과 휴대전화를 확인하세요.")
            return
        if (
            QMessageBox.question(
                self,
                "계정 생성 확인",
                f"{self._client.config.environment_label}\n\n"
                f"{display_name} 계정을 {role} 역할로 생성합니까?",
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        self.buttons.setEnabled(False)
        worker = Worker(
            lambda: self._client.create_account(
                display_name=display_name,
                role=role,
                phone=phone,
            )
        )
        worker.signals.succeeded.connect(self._created)
        worker.signals.failed.connect(lambda error: show_api_error(self, cast(ApiError, error)))
        worker.signals.finished.connect(lambda: self.buttons.setEnabled(True))
        self._pool.start(worker)

    def _created(self, result: object) -> None:
        account, temporary_password = cast(tuple[Account, str], result)
        dialog = QMessageBox(self)
        dialog.setWindowTitle("계정 생성 완료 — 한 번만 표시")
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setText(
            f"로그인 ID: {html.escape(account.login_id)}\n"
            f"임시 비밀번호: {html.escape(temporary_password)}"
        )
        dialog.setInformativeText(
            "임시 비밀번호는 저장·복사 기능을 제공하지 않습니다. 대상자에게 안전하게 전달하고 "
            "최초 로그인에서 개인 비밀번호로 변경하세요."
        )
        dialog.exec()
        temporary_password = ""
        self.account_created.emit(account, temporary_password)
        self.accept()


class AccountsPage(QWidget):
    def __init__(self, client: BackendApiClient) -> None:
        super().__init__()
        self._client = client
        self._pool = QThreadPool.globalInstance()
        self._accounts: list[Account] = []

        layout = QVBoxLayout(self)
        controls = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("이름 또는 로그인 ID 검색")
        self.search.textChanged.connect(self._render)
        refresh = QPushButton("새로고침")
        refresh.clicked.connect(self.refresh)
        create = QPushButton("계정 생성")
        create.clicked.connect(self._create)
        controls.addWidget(self.search, 1)
        controls.addWidget(refresh)
        controls.addWidget(create)
        layout.addLayout(controls)

        self.table = QTableWidget(0, 8)
        self.table.setHorizontalHeaderLabels(
            [
                "표시 이름",
                "로그인 ID",
                "역할",
                "상태",
                "전화 끝 4자리",
                "비밀번호 변경",
                "실패",
                "잠금",
            ]
        )
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.itemSelectionChanged.connect(self._update_actions)
        layout.addWidget(self.table)

        actions = QHBoxLayout()
        self.role_button = QPushButton("역할 변경")
        self.status_button = QPushButton("상태 변경")
        self.unlock_button = QPushButton("잠금 해제")
        self.reset_button = QPushButton("비밀번호 초기화")
        self.role_button.clicked.connect(self._change_role)
        self.status_button.clicked.connect(self._change_status)
        self.unlock_button.clicked.connect(self._unlock)
        self.reset_button.clicked.connect(self._reset_password)
        for button in (
            self.role_button,
            self.status_button,
            self.unlock_button,
            self.reset_button,
        ):
            actions.addWidget(button)
        actions.addStretch(1)
        layout.addLayout(actions)
        self._update_actions()

    def refresh(self) -> None:
        self._run(self._client.list_accounts, self._set_accounts)

    def _run(self, task: Callable[[], Any], on_success: Callable[[object], None]) -> None:
        worker = Worker(task)
        worker.signals.succeeded.connect(on_success)
        worker.signals.failed.connect(lambda error: show_api_error(self, cast(ApiError, error)))
        self._pool.start(worker)

    def _set_accounts(self, value: object) -> None:
        self._accounts = cast(list[Account], value)
        self._render()

    def _render(self) -> None:
        needle = self.search.text().strip().lower()
        filtered = [
            account
            for account in self._accounts
            if not needle
            or needle in account.display_name.lower()
            or needle in account.login_id.lower()
        ]
        self.table.setRowCount(len(filtered))
        for row, account in enumerate(filtered):
            values = [
                account.display_name,
                account.login_id,
                account.role,
                account.status,
                account.phone_last_four or "—",
                "필요" if account.must_change_password else "완료",
                str(account.failed_login_count),
                account.locked_until or "—",
            ]
            for column, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setData(Qt.ItemDataRole.UserRole, account.id)
                self.table.setItem(row, column, item)
        self._update_actions()

    def _selected(self) -> Account | None:
        row = self.table.currentRow()
        if row < 0:
            return None
        item = self.table.item(row, 0)
        profile_id = str(item.data(Qt.ItemDataRole.UserRole)) if item else ""
        return next((account for account in self._accounts if account.id == profile_id), None)

    def _update_actions(self) -> None:
        account = self._selected()
        if not account:
            for button in (
                self.role_button,
                self.status_button,
                self.unlock_button,
                self.reset_button,
            ):
                button.setEnabled(False)
            return
        active_admins = sum(
            item.role == "admin" and item.status == "active" for item in self._accounts
        )
        policy = account_action_policy(account, active_admins)
        self.role_button.setEnabled(policy.can_change_role)
        self.status_button.setEnabled(policy.can_change_status)
        self.unlock_button.setEnabled(policy.can_unlock)
        self.reset_button.setEnabled(policy.can_reset_password)
        for button in (self.role_button, self.status_button):
            button.setToolTip(policy.warning or "")

    def _create(self) -> None:
        dialog = CreateAccountDialog(self._client, self)
        dialog.account_created.connect(lambda _account, _password: self.refresh())
        dialog.exec()

    def _change_role(self) -> None:
        account = self._selected()
        if not account:
            return
        target = "maid" if account.role == "admin" else "admin"
        if not self._confirm(account, f"역할을 {account.role} → {target}(으)로 변경"):
            return
        self._run(
            lambda: self._client.change_account_role(account.id, target), lambda _v: self.refresh()
        )

    def _change_status(self) -> None:
        account = self._selected()
        if not account:
            return
        if account.status not in ACCOUNT_STATUS_TARGETS:
            QMessageBox.information(
                self,
                "상태 변경 불가",
                "deactivation_pending/upload_only 계정은 서버 lifecycle이 끝난 뒤 변경하세요.",
            )
            return
        dialog = QDialog(self)
        dialog.setWindowTitle("계정 상태 변경")
        layout = QFormLayout(dialog)
        status = QComboBox()
        for value in ("active", "inactive", "departed"):
            status.addItem(value, value)
        status.setCurrentText(account.status)
        reason = QLineEdit()
        reason.setPlaceholderText("예: OPERATOR_REQUEST")
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addRow("새 상태", status)
        layout.addRow("사유 코드", reason)
        layout.addRow(buttons)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        reason_code = reason.text().strip().upper()
        if not REASON_CODE.fullmatch(reason_code):
            QMessageBox.information(
                self, "입력 확인", "사유 코드는 영문 대문자·숫자·밑줄 2~80자입니다."
            )
            return
        target = cast(AccountStatusTarget, str(status.currentData()))
        if not self._confirm(account, f"상태를 {account.status} → {target}(으)로 변경"):
            return
        self._run(
            lambda: self._client.change_account_status(account.id, target, reason_code),
            lambda _v: self.refresh(),
        )

    def _unlock(self) -> None:
        account = self._selected()
        if account and self._confirm(account, "로그인 실패 횟수와 잠금을 해제"):
            self._run(lambda: self._client.unlock_account(account.id), lambda _v: self.refresh())

    def _reset_password(self) -> None:
        account = self._selected()
        if account and self._confirm(
            account,
            f"비밀번호를 휴대전화 끝 4자리({account.phone_last_four or '없음'}) 임시값으로 초기화",
        ):
            self._run(
                lambda: self._client.reset_account_password(account.id),
                lambda _v: self.refresh(),
            )

    def _confirm(self, account: Account, action: str) -> bool:
        return (
            QMessageBox.warning(
                self,
                "운영 변경 확인",
                f"{self._client.config.environment_label}\n\n"
                f"{account.display_name} ({account.login_id})\n{action}합니까?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            == QMessageBox.StandardButton.Yes
        )


class DashboardPage(QWidget):
    def __init__(self, client: BackendApiClient) -> None:
        super().__init__()
        self._client = client
        self._pool = QThreadPool.globalInstance()
        layout = QVBoxLayout(self)
        controls = QHBoxLayout()
        refresh = QPushButton("운영 상태 새로고침")
        refresh.clicked.connect(self.refresh)
        diagnostics = QPushButton("수동 진단 1회")
        diagnostics.clicked.connect(self._diagnostics)
        controls.addWidget(refresh)
        controls.addWidget(diagnostics)
        controls.addStretch(1)
        layout.addLayout(controls)
        self.view = QTextBrowser()
        self.view.setOpenExternalLinks(False)
        layout.addWidget(self.view)

    def refresh(self) -> None:
        self._run(self._client.developer_overview, self._render_overview)

    def _diagnostics(self) -> None:
        self._run(self._client.run_diagnostics, self._render_diagnostics)

    def _run(self, task: Callable[[], Any], callback: Callable[[object], None]) -> None:
        worker = Worker(task)
        worker.signals.succeeded.connect(callback)
        worker.signals.failed.connect(lambda error: show_api_error(self, cast(ApiError, error)))
        self._pool.start(worker)

    def _render_overview(self, value: object) -> None:
        overview = cast(dict[str, Any], value)
        runtime = cast(dict[str, Any], overview.get("runtime", {}))
        database = cast(dict[str, Any], overview.get("database", {}))
        scheduler = cast(dict[str, Any], overview.get("scheduler", {}))
        accounts = cast(dict[str, Any], overview.get("accounts", {}))
        by_role = cast(dict[str, Any], accounts.get("byRole", {}))
        configuration = cast(dict[str, Any], runtime.get("configuration", {}))
        configured_items = []
        for name, state in configuration.items():
            state_text = (
                "설정됨" if isinstance(state, dict) and state.get("configured") else "미설정"
            )
            configured_items.append(f"{html.escape(str(name))}: {state_text}")
        configured = "<br>".join(configured_items)
        role_counts = (
            f"developer {by_role.get('developer', 0)} / "
            f"admin {by_role.get('admin', 0)} / maid {by_role.get('maid', 0)}"
        )
        migration_drift = html.escape(str(database.get("migrationDrift", "unknown")))
        self.view.setHtml(
            "<h2>운영 개요</h2>"
            f"<p><b>{html.escape(str(runtime.get('environment', 'unknown')).upper())}</b> / "
            f"project {html.escape(str(runtime.get('projectRef', 'unknown')))}</p>"
            f"<h3>계정</h3><p>전체 {accounts.get('total', 0)} / "
            f"active {accounts.get('active', 0)} / {role_counts}</p>"
            f"<h3>Database</h3><p>migration: {migration_drift} / "
            f"RLS: {'정상' if database.get('rlsValid') else '확인 필요'} / "
            f"누락 {database.get('rlsMissingCount', '?')}</p>"
            f"<h3>Scheduler</h3><p>{html.escape(str(scheduler.get('status', 'unknown')))}</p>"
            f"<h3>Secret 설정 여부</h3><p>{configured or '정보 없음'}</p>"
        )

    def _render_diagnostics(self, value: object) -> None:
        diagnostics = cast(dict[str, Any], value)
        rows = "".join(
            f"<li>{html.escape(str(item.get('id')))}: {html.escape(str(item.get('status')))}"
            f" {html.escape(str(item.get('errorCode', '')))}</li>"
            for item in cast(list[dict[str, Any]], diagnostics.get("checks", []))
        )
        status = html.escape(str(diagnostics.get("status", "unknown")))
        self.view.setHtml(f"<h2>진단: {status}</h2><ul>{rows}</ul>")


class AuditPage(QWidget):
    def __init__(self, client: BackendApiClient) -> None:
        super().__init__()
        self._client = client
        self._pool = QThreadPool.globalInstance()
        self._cursor: str | None = None
        layout = QVBoxLayout(self)
        controls = QHBoxLayout()
        refresh = QPushButton("최근 감사 조회")
        refresh.clicked.connect(self.refresh)
        self.next_button = QPushButton("다음 페이지")
        self.next_button.clicked.connect(self.next_page)
        self.next_button.setEnabled(False)
        controls.addWidget(refresh)
        controls.addWidget(self.next_button)
        controls.addStretch(1)
        layout.addLayout(controls)
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(
            ["기록 시각", "이벤트", "대상", "행위자", "사유", "안전 요약"]
        )
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setStretchLastSection(True)
        layout.addWidget(self.table)

    def refresh(self) -> None:
        self._cursor = None
        self._load(None)

    def next_page(self) -> None:
        self._load(self._cursor)

    def _load(self, cursor: str | None) -> None:
        worker = Worker(lambda: self._client.developer_audit_events(cursor=cursor))
        worker.signals.succeeded.connect(self._render)
        worker.signals.failed.connect(lambda error: show_api_error(self, cast(ApiError, error)))
        self._pool.start(worker)

    def _render(self, value: object) -> None:
        page = cast(dict[str, Any], value)
        events = cast(list[dict[str, Any]], page.get("events", []))
        self._cursor = cast(str | None, page.get("nextCursor"))
        self.next_button.setEnabled(bool(self._cursor))
        self.table.setRowCount(len(events))
        for row, event in enumerate(events):
            summary = event.get("summary", {})
            values = [
                str(event.get("recordedAt", "")),
                str(event.get("eventType", "")),
                f"{event.get('entityType', '')}:{event.get('entityId', '')}",
                str(event.get("actorDisplayName") or event.get("actorProfileId") or "system"),
                str(event.get("reasonCode") or "—"),
                json_summary(summary),
            ]
            for column, text in enumerate(values):
                self.table.setItem(row, column, QTableWidgetItem(text))


def json_summary(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    return ", ".join(f"{key}={item}" for key, item in value.items())


class ActivityFilter(QObject):
    activity = Signal()

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if event.type() in {
            QEvent.Type.KeyPress,
            QEvent.Type.MouseButtonPress,
            QEvent.Type.MouseMove,
            QEvent.Type.Wheel,
            QEvent.Type.TouchBegin,
        }:
            self.activity.emit()
        return super().eventFilter(watched, event)


class MainWindow(QMainWindow):
    locked = Signal()

    def __init__(self, config: AppConfig, client: BackendApiClient) -> None:
        super().__init__()
        self._client = client
        self._closing_for_lock = False
        self.setWindowTitle("CASTLE THE ART 백엔드 운영 콘솔")
        self.resize(1120, 760)

        central = QWidget()
        layout = QVBoxLayout(central)
        self.environment_banner = QLabel(config.environment_label)
        self.environment_banner.setObjectName("environmentBanner")
        self.environment_banner.setStyleSheet(
            "font-size: 15px; font-weight: 800; padding: 10px; background: #182230; color: white;"
        )
        layout.addWidget(self.environment_banner)
        actor = client.actor
        layout.addWidget(
            QLabel(f"로그인: {actor.display_name if actor else 'unknown'} (developer)")
        )

        tabs = QTabWidget()
        self.dashboard = DashboardPage(client)
        self.accounts = AccountsPage(client)
        self.audit = AuditPage(client)
        tabs.addTab(self.dashboard, "운영 대시보드")
        tabs.addTab(self.accounts, "계정 관리")
        tabs.addTab(self.audit, "감사 이벤트")
        layout.addWidget(tabs)
        self.setCentralWidget(central)

        lock_action = QAction("잠금 및 로그아웃", self)
        lock_action.triggered.connect(self.lock_now)
        self.menuBar().addAction(lock_action)

        self._activity_filter = ActivityFilter(self)
        application = QApplication.instance()
        if application is None:
            raise RuntimeError("QApplication이 필요합니다.")
        application.installEventFilter(self._activity_filter)
        self._inactivity_timer = QTimer(self)
        self._inactivity_timer.setSingleShot(True)
        self._inactivity_timer.setInterval(config.inactivity_minutes * 60 * 1000)
        self._activity_filter.activity.connect(self._inactivity_timer.start)
        self._inactivity_timer.timeout.connect(self.lock_now)
        self._inactivity_timer.start()

        self.dashboard.refresh()
        self.accounts.refresh()

    def lock_now(self) -> None:
        self._closing_for_lock = True
        self._inactivity_timer.stop()
        self._client.lock(logout=True)
        self.locked.emit()
        self.close()

    def closeEvent(self, event: QCloseEvent) -> None:
        application = QApplication.instance()
        if application is not None:
            application.removeEventFilter(self._activity_filter)
        if not self._closing_for_lock:
            self._client.close()
            QApplication.quit()
        super().closeEvent(event)
