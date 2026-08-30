from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Any

import httpx
import pytest

from room_management_console.api_client import ApiError, BackendApiClient
from room_management_console.config import AppConfig

PROJECT_URL = "https://abcdefgh.supabase.co"


def config() -> AppConfig:
    return AppConfig(
        environment="production",
        project_ref="abcdefgh",
        supabase_url=PROJECT_URL,
        publishable_key="sb_publishable_example_only_1234567890",
    )


def actor(role: str = "developer", *, must_change: bool = False) -> dict[str, Any]:
    return {
        "authUserId": "00000000-0000-4000-8000-000000000010",
        "profileId": "00000000-0000-4000-8000-000000000011",
        "displayName": "개발자",
        "role": role,
        "mustChangePassword": must_change,
    }


def account() -> dict[str, Any]:
    return {
        "id": "00000000-0000-4000-8000-000000000020",
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
    }


def login_response(role: str = "developer") -> dict[str, Any]:
    return {
        "accessToken": "access-token-value",
        "refreshToken": "refresh-token-value",
        "expiresIn": 3600,
        "user": actor(role),
    }


def transport(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def test_login_rejects_business_roles_and_discards_session() -> None:
    client = BackendApiClient(
        config(),
        transport=transport(lambda request: httpx.Response(200, json=login_response("admin"))),
    )
    with pytest.raises(ApiError, match="developer"):
        client.login("admin", "not-a-real-password")
    assert not client.is_authenticated


def test_network_retry_reuses_command_key_without_retaining_phone_payload() -> None:
    command_keys: list[str] = []
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(200, json=login_response())
        if request.url.path.endswith("/v1/accounts"):
            attempts += 1
            command_keys.append(request.headers["Idempotency-Key"])
            if attempts == 1:
                raise httpx.ConnectError("simulated", request=request)
            return httpx.Response(
                201,
                json={"account": account(), "temporaryPassword": "0000"},
            )
        raise AssertionError(request.url.path)

    client = BackendApiClient(config(), transport=transport(handler))
    client.login("admin", "not-a-real-password")
    with pytest.raises(ApiError, match="연결"):
        client.create_account(display_name="운영 관리자", role="admin", phone="01000000000")
    pending_hashes = client._commands.debug_hashes()
    assert len(pending_hashes) == 1
    assert all(len(value) == 64 for value in pending_hashes)
    created, temporary_password = client.create_account(
        display_name="운영 관리자", role="admin", phone="01000000000"
    )
    assert created.role == "admin"
    assert temporary_password == "0000"
    assert len(set(command_keys)) == 1
    assert client._commands.debug_hashes() == ()


def test_transport_error_does_not_retain_request_body_as_exception_cause() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated", request=request)

    client = BackendApiClient(config(), transport=transport(handler))
    with pytest.raises(ApiError) as error:
        client.login("admin", "not-a-real-password")
    assert error.value.__cause__ is None


def test_retry_with_different_payload_fails_closed() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(200, json=login_response())
        attempts += 1
        raise httpx.ConnectError("simulated", request=request)

    client = BackendApiClient(config(), transport=transport(handler))
    client.login("admin", "not-a-real-password")
    with pytest.raises(ApiError):
        client.create_account(display_name="첫 입력", role="maid", phone="01000000000")
    with pytest.raises(ApiError) as error:
        client.create_account(display_name="다른 입력", role="maid", phone="01000000001")
    assert error.value.code == "PENDING_COMMAND_PAYLOAD_MISMATCH"
    assert attempts == 1


def test_refresh_rotates_memory_tokens_before_protected_request() -> None:
    authorization: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(200, json=login_response())
        if request.url.path.endswith("/auth/v1/token"):
            assert request.url.params["grant_type"] == "refresh_token"
            return httpx.Response(
                200,
                json={
                    "access_token": "rotated-access",
                    "refresh_token": "rotated-refresh",
                    "expires_in": 3600,
                },
            )
        if request.url.path.endswith("/v1/auth/me"):
            authorization.append(request.headers["Authorization"])
            return httpx.Response(200, json={"user": actor()})
        if request.url.path.endswith("/v1/accounts"):
            authorization.append(request.headers["Authorization"])
            return httpx.Response(200, json={"accounts": [account()]})
        raise AssertionError(request.url.path)

    client = BackendApiClient(config(), transport=transport(handler))
    client.login("admin", "not-a-real-password")
    assert client._session is not None
    client._session.expires_at_monotonic = 0
    assert len(client.list_accounts()) == 1
    assert authorization == ["Bearer rotated-access", "Bearer rotated-access"]


def test_concurrent_protected_requests_rotate_refresh_token_once() -> None:
    refresh_count = 0
    counter_lock = Lock()

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal refresh_count
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(200, json=login_response())
        if request.url.path.endswith("/auth/v1/token"):
            with counter_lock:
                refresh_count += 1
            return httpx.Response(
                200,
                json={
                    "access_token": "rotated-access",
                    "refresh_token": "rotated-refresh",
                    "expires_in": 3600,
                },
            )
        if request.url.path.endswith("/v1/auth/me"):
            return httpx.Response(200, json={"user": actor()})
        if request.url.path.endswith("/v1/accounts"):
            return httpx.Response(200, json={"accounts": [account()]})
        raise AssertionError(request.url.path)

    client = BackendApiClient(config(), transport=transport(handler))
    client.login("admin", "not-a-real-password")
    assert client._session is not None
    client._session.expires_at_monotonic = 0
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: client.list_accounts(), range(2)))
    assert [len(result) for result in results] == [1, 1]
    assert refresh_count == 1


def test_error_exposes_only_code_message_and_request_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "error": {
                    "code": "INVALID_CREDENTIALS",
                    "message": "로그인 정보가 올바르지 않습니다: 01000000000",
                },
                "requestId": "request-safe-id",
                "debug": "must-not-be-exposed",
            },
        )

    client = BackendApiClient(config(), transport=transport(handler))
    with pytest.raises(ApiError) as error:
        client.login("admin", "not-a-real-password")
    assert error.value.safe_summary().endswith("(요청 ID: request-safe-id)")
    assert "must-not-be-exposed" not in error.value.safe_summary()
    assert "01000000000" not in error.value.safe_summary()
