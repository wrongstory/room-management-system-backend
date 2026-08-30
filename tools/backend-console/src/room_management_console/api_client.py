from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from threading import Lock, RLock
from typing import Any
from uuid import UUID, uuid4

import httpx

from .config import AppConfig
from .generated.models.account import Account as GeneratedAccount
from .generated.models.actor import Actor as GeneratedActor
from .models import Account, Actor, CommandReceipt, MemorySession
from .redaction import redact_text


class ApiError(RuntimeError):
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        request_id: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after

    def safe_summary(self) -> str:
        request = f" (요청 ID: {self.request_id})" if self.request_id else ""
        return f"{self.args[0]} [{self.code}]{request}"


class ApiTransportError(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=0,
            code="NETWORK_ERROR",
            message="서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.",
        )


@dataclass(slots=True)
class _PendingCommand:
    receipt: CommandReceipt


class InMemoryCommandRegistry:
    """PII payload는 보관하지 않고 canonical hash와 command key만 메모리에 유지한다."""

    def __init__(self) -> None:
        self._pending: dict[str, _PendingCommand] = {}
        self._lock = Lock()

    @staticmethod
    def _hash(body: Mapping[str, Any] | None) -> str:
        encoded = json.dumps(body or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def receipt_for(self, scope: str, body: Mapping[str, Any] | None) -> CommandReceipt:
        request_hash = self._hash(body)
        with self._lock:
            pending = self._pending.get(scope)
            if pending:
                if pending.receipt.request_hash != request_hash:
                    raise ApiError(
                        status_code=409,
                        code="PENDING_COMMAND_PAYLOAD_MISMATCH",
                        message=(
                            "이전 요청의 처리 결과가 불확실합니다. 같은 입력으로 재시도하거나 "
                            "잠근 뒤 다시 로그인하세요."
                        ),
                    )
                return pending.receipt
            receipt = CommandReceipt(scope, request_hash, str(uuid4()))
            self._pending[scope] = _PendingCommand(receipt)
            return receipt

    def complete(self, scope: str) -> None:
        with self._lock:
            self._pending.pop(scope, None)

    def clear(self) -> None:
        with self._lock:
            self._pending.clear()

    def debug_hashes(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(item.receipt.request_hash for item in self._pending.values())


class BackendApiClient:
    def __init__(self, config: AppConfig, *, transport: httpx.BaseTransport | None = None) -> None:
        self.config = config
        self._session: MemorySession | None = None
        self._session_lock = RLock()
        self._commands = InMemoryCommandRegistry()
        self._http = httpx.Client(
            timeout=httpx.Timeout(15.0, connect=8.0),
            follow_redirects=False,
            transport=transport,
            headers={
                "Accept": "application/json",
                "apikey": config.publishable_key,
                "User-Agent": "room-management-backend-console/0.1.0",
            },
        )

    @property
    def actor(self) -> Actor | None:
        with self._session_lock:
            return self._session.actor if self._session else None

    @property
    def is_authenticated(self) -> bool:
        with self._session_lock:
            return bool(self._session and self._session.access_token)

    def close(self) -> None:
        self.lock(logout=True)
        self._http.close()

    def login(self, login_id: str, password: str) -> Actor:
        if login_id.strip() != "admin":
            raise ApiError(
                status_code=400,
                code="DEVELOPER_LOGIN_REQUIRED",
                message="이 운영도구는 고정 developer 로그인 ID만 사용할 수 있습니다.",
            )
        response = self._send(
            "POST",
            f"{self.config.api_base_url}/v1/auth/login",
            json_body={"loginId": "admin", "password": password},
        )
        body = self._success_json(response)
        actor_value = self._object(body, "user")
        GeneratedActor.from_dict(actor_value)
        actor = Actor.from_dict(actor_value)
        if actor.role != "developer" or actor.must_change_password:
            raise ApiError(
                status_code=403,
                code="DEVELOPER_REQUIRED",
                message="활성 developer 계정과 비밀번호 변경 완료가 필요합니다.",
            )
        with self._session_lock:
            self._session = MemorySession.create(
                access_token=self._string(body, "accessToken"),
                refresh_token=self._string(body, "refreshToken"),
                expires_in=self._integer(body, "expiresIn"),
                actor=actor,
            )
        return actor

    def lock(self, *, logout: bool) -> None:
        with self._session_lock:
            session = self._session
            if logout and session and session.access_token:
                with suppress(ApiError):
                    self._send(
                        "POST",
                        f"{self.config.auth_base_url}/logout?scope=local",
                        token=session.access_token,
                    )
            if session:
                session.clear()
            self._session = None
            self._commands.clear()

    def refresh_session(self) -> Actor:
        with self._session_lock:
            session = self._require_session()
            response = self._send(
                "POST",
                f"{self.config.auth_base_url}/token?grant_type=refresh_token",
                json_body={"refresh_token": session.refresh_token},
            )
            body = self._success_json(response)
            access_token = self._string(body, "access_token")
            refresh_token = self._string(body, "refresh_token")
            expires_in = self._integer(body, "expires_in")
            me = self._send(
                "GET",
                f"{self.config.api_base_url}/v1/auth/me",
                token=access_token,
            )
            me_body = self._success_json(me)
            actor_value = self._object(me_body, "user")
            GeneratedActor.from_dict(actor_value)
            actor = Actor.from_dict(actor_value)
            if actor.role != "developer" or actor.must_change_password:
                self.lock(logout=False)
                raise ApiError(
                    status_code=403,
                    code="DEVELOPER_REQUIRED",
                    message="developer 권한 또는 세션 상태가 변경되어 잠겼습니다.",
                )
            session.clear()
            self._session = MemorySession.create(
                access_token=access_token,
                refresh_token=refresh_token,
                expires_in=expires_in,
                actor=actor,
            )
            return actor

    def current_user(self) -> Actor:
        body = self._authorized_json("GET", "/v1/auth/me")
        actor_value = self._object(body, "user")
        GeneratedActor.from_dict(actor_value)
        actor = Actor.from_dict(actor_value)
        if actor.role != "developer" or actor.must_change_password:
            self.lock(logout=False)
            raise ApiError(
                status_code=403,
                code="DEVELOPER_REQUIRED",
                message="developer 권한이 아니므로 세션을 잠갔습니다.",
            )
        return actor

    def list_accounts(self) -> list[Account]:
        body = self._authorized_json("GET", "/v1/accounts")
        values = body.get("accounts")
        if not isinstance(values, list):
            raise self._contract_error()
        accounts: list[Account] = []
        for value in values:
            if not isinstance(value, dict):
                raise self._contract_error()
            GeneratedAccount.from_dict(value)
            accounts.append(Account.from_dict(value))
        return accounts

    def create_account(self, *, display_name: str, role: str, phone: str) -> tuple[Account, str]:
        body = {"displayName": display_name, "role": role, "phone": phone}
        response = self._command_json("POST", "/v1/accounts", "account.create", body)
        return self._account_from_response(response), self._string(response, "temporaryPassword")

    def change_account_role(self, profile_id: str, role: str) -> Account:
        body = {"role": role}
        response = self._command_json(
            "PATCH",
            f"/v1/accounts/{self._uuid(profile_id)}/role",
            f"account.role:{profile_id}",
            body,
        )
        return self._account_from_response(response)

    def change_account_status(self, profile_id: str, status: str, reason_code: str) -> Account:
        body = {"status": status, "reasonCode": reason_code}
        response = self._command_json(
            "PATCH",
            f"/v1/accounts/{self._uuid(profile_id)}/status",
            f"account.status:{profile_id}",
            body,
        )
        return self._account_from_response(response)

    def unlock_account(self, profile_id: str) -> Account:
        response = self._command_json(
            "POST",
            f"/v1/accounts/{self._uuid(profile_id)}/unlock",
            f"account.unlock:{profile_id}",
            None,
        )
        return self._account_from_response(response)

    def reset_account_password(self, profile_id: str) -> Account:
        response = self._command_json(
            "POST",
            f"/v1/accounts/{self._uuid(profile_id)}/password-reset",
            f"account.password-reset:{profile_id}",
            None,
        )
        return self._account_from_response(response)

    def developer_overview(self) -> dict[str, Any]:
        return self._object(self._authorized_json("GET", "/v1/developer/overview"), "overview")

    def developer_runtime_status(self) -> dict[str, Any]:
        return self._object(self._authorized_json("GET", "/v1/developer/runtime-status"), "runtime")

    def developer_database_status(self) -> dict[str, Any]:
        return self._object(
            self._authorized_json("GET", "/v1/developer/database-status"), "database"
        )

    def developer_scheduler_status(self) -> dict[str, Any]:
        return self._object(
            self._authorized_json("GET", "/v1/developer/scheduler-status"), "scheduler"
        )

    def developer_audit_events(
        self,
        *,
        event_types: Iterable[str] = (),
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        parameters: list[tuple[str, str | int | float | bool | None]] = [("limit", str(limit))]
        parameters.extend(("eventType", event_type) for event_type in event_types)
        if cursor:
            parameters.append(("cursor", cursor))
        return self._authorized_json("GET", "/v1/developer/audit-events", params=parameters)

    def run_diagnostics(self) -> dict[str, Any]:
        return self._object(
            self._authorized_json("POST", "/v1/developer/diagnostics"), "diagnostics"
        )

    def _command_json(
        self,
        method: str,
        path: str,
        scope: str,
        body: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        receipt = self._commands.receipt_for(scope, body)
        try:
            result = self._authorized_json(
                method,
                path,
                json_body=body,
                extra_headers={"Idempotency-Key": receipt.idempotency_key},
            )
        except ApiError as error:
            if 0 < error.status_code < 500 and error.status_code not in {408, 429}:
                self._commands.complete(scope)
            raise
        self._commands.complete(scope)
        return result

    def _authorized_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        params: list[tuple[str, str | int | float | bool | None]] | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        with self._session_lock:
            session = self._require_session()
            if session.expires_within(60):
                self.refresh_session()
                session = self._require_session()
            access_token = session.access_token
        try:
            response = self._send(
                method,
                f"{self.config.api_base_url}{path}",
                token=access_token,
                json_body=json_body,
                params=params,
                extra_headers=extra_headers,
            )
        except ApiError as error:
            if error.status_code != 401:
                raise
            with self._session_lock:
                current = self._require_session()
                if current.access_token == access_token:
                    self.refresh_session()
                    current = self._require_session()
                access_token = current.access_token
            response = self._send(
                method,
                f"{self.config.api_base_url}{path}",
                token=access_token,
                json_body=json_body,
                params=params,
                extra_headers=extra_headers,
            )
        return self._success_json(response)

    def _send(
        self,
        method: str,
        url: str,
        *,
        token: str | None = None,
        json_body: Mapping[str, Any] | None = None,
        params: list[tuple[str, str | int | float | bool | None]] | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        headers = dict(extra_headers or {})
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            response = self._http.request(
                method,
                url,
                headers=headers,
                json=json_body,
                params=params,
            )
        except httpx.HTTPError:
            raise ApiTransportError() from None
        if response.is_success:
            return response
        self._raise_api_error(response)
        raise AssertionError("unreachable")

    @staticmethod
    def _raise_api_error(response: httpx.Response) -> None:
        code = "HTTP_ERROR"
        message = "요청을 처리하지 못했습니다."
        request_id: str | None = None
        try:
            body = response.json()
            if isinstance(body, dict):
                error = body.get("error")
                if isinstance(error, dict):
                    if isinstance(error.get("code"), str):
                        code = error["code"]
                    if isinstance(error.get("message"), str):
                        message = redact_text(error["message"])
                if isinstance(body.get("requestId"), str):
                    request_id = body["requestId"]
        except (ValueError, json.JSONDecodeError):
            pass
        retry_value = response.headers.get("Retry-After", "")
        retry_after = int(retry_value) if retry_value.isdigit() else None
        raise ApiError(
            status_code=response.status_code,
            code=code,
            message=message,
            request_id=request_id,
            retry_after=retry_after,
        )

    @staticmethod
    def _success_json(response: httpx.Response) -> dict[str, Any]:
        try:
            value = response.json()
        except (ValueError, json.JSONDecodeError) as error:
            raise BackendApiClient._contract_error() from error
        if not isinstance(value, dict):
            raise BackendApiClient._contract_error()
        return value

    def _require_session(self) -> MemorySession:
        if not self._session or not self._session.access_token:
            raise ApiError(
                status_code=401,
                code="AUTHENTICATION_REQUIRED",
                message="다시 로그인해 주세요.",
            )
        return self._session

    @staticmethod
    def _object(body: Mapping[str, Any], key: str) -> dict[str, Any]:
        value = body.get(key)
        if not isinstance(value, dict):
            raise BackendApiClient._contract_error()
        return value

    @staticmethod
    def _string(body: Mapping[str, Any], key: str) -> str:
        value = body.get(key)
        if not isinstance(value, str) or not value:
            raise BackendApiClient._contract_error()
        return value

    @staticmethod
    def _integer(body: Mapping[str, Any], key: str) -> int:
        value = body.get(key)
        if not isinstance(value, int) or value <= 0:
            raise BackendApiClient._contract_error()
        return value

    @staticmethod
    def _uuid(value: str) -> str:
        try:
            return str(UUID(value))
        except ValueError as error:
            raise ApiError(
                status_code=400,
                code="VALIDATION_ERROR",
                message="계정 profile ID가 올바르지 않습니다.",
            ) from error

    @staticmethod
    def _account_from_response(body: Mapping[str, Any]) -> Account:
        value = BackendApiClient._object(body, "account")
        GeneratedAccount.from_dict(value)
        return Account.from_dict(value)

    @staticmethod
    def _contract_error() -> ApiError:
        return ApiError(
            status_code=502,
            code="API_CONTRACT_MISMATCH",
            message="서버 응답이 현재 운영도구 계약과 다릅니다. 운영도구 버전을 확인하세요.",
        )
