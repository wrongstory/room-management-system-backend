from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Any

import httpx
import pytest

from room_management_console.api_client import ApiError, BackendApiClient
from room_management_console.approved_targets import APPROVED_HOSTED_TARGETS
from room_management_console.config import AppConfig

PRODUCTION_TARGET = APPROVED_HOSTED_TARGETS["production"]
PROJECT_URL = PRODUCTION_TARGET.supabase_url


def config() -> AppConfig:
    return AppConfig(
        environment="production",
        project_ref=PRODUCTION_TARGET.project_ref,
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


def account(*, status: str = "active", profile_suffix: str = "20") -> dict[str, Any]:
    return {
        "id": f"00000000-0000-4000-8000-0000000000{profile_suffix}",
        "displayName": "운영 관리자",
        "loginId": "operator",
        "role": "admin",
        "status": status,
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


def runtime_response(
    *, environment: str = "production", project_ref: str = PRODUCTION_TARGET.project_ref
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "runtime": {
                "adapter": "supabase-edge",
                "environment": environment,
                "projectRef": project_ref,
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


def transport(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    runtime_environment: str = "production",
    runtime_project_ref: str = PRODUCTION_TARGET.project_ref,
) -> httpx.MockTransport:
    def routed(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v1/developer/runtime-status"):
            return runtime_response(
                environment=runtime_environment,
                project_ref=runtime_project_ref,
            )
        if request.url.path.endswith("/auth/v1/logout"):
            return httpx.Response(204)
        return handler(request)

    return httpx.MockTransport(routed)


def test_login_rejects_business_roles_and_discards_session() -> None:
    client = BackendApiClient(
        config(),
        transport=transport(lambda request: httpx.Response(200, json=login_response("admin"))),
    )
    with pytest.raises(ApiError, match="developer"):
        client.login("admin", "not-a-real-password")
    assert not client.is_authenticated


def test_unapproved_hosted_target_is_rejected_before_any_http_request() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500)

    unsafe_config = AppConfig(
        environment="production",
        project_ref="unapprovedprojectref00",
        supabase_url="https://unapprovedprojectref00.supabase.co",
        publishable_key="sb_publishable_example_only_1234567890",
    )
    with pytest.raises(ValueError, match="승인되지 않은"):
        BackendApiClient(unsafe_config, transport=httpx.MockTransport(handler))
    assert request_count == 0


def test_runtime_target_mismatch_locks_session_before_mutation_ui_can_open() -> None:
    recovery = APPROVED_HOSTED_TARGETS["recovery"]
    client = BackendApiClient(
        config(),
        transport=transport(
            lambda request: httpx.Response(200, json=login_response()),
            runtime_environment="recovery",
            runtime_project_ref=recovery.project_ref,
        ),
    )
    with pytest.raises(ApiError) as error:
        client.login("admin", "not-a-real-password")
    assert error.value.code == "RUNTIME_TARGET_MISMATCH"
    assert not client.is_authenticated
    with pytest.raises(ApiError) as account_error:
        client.list_accounts()
    assert account_error.value.code == "AUTHENTICATION_REQUIRED"


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


def test_account_list_accepts_transitional_statuses_without_coercion() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(200, json=login_response())
        if request.url.path.endswith("/v1/accounts"):
            return httpx.Response(
                200,
                json={
                    "accounts": [
                        account(status="deactivation_pending", profile_suffix="21"),
                        account(status="upload_only", profile_suffix="22"),
                    ]
                },
            )
        raise AssertionError(request.url.path)

    client = BackendApiClient(config(), transport=transport(handler))
    client.login("admin", "not-a-real-password")
    accounts = client.list_accounts()
    assert [item.status for item in accounts] == ["deactivation_pending", "upload_only"]


def test_status_command_rejects_transitional_target_before_http_request() -> None:
    client = BackendApiClient(
        config(), transport=transport(lambda request: httpx.Response(200, json=login_response()))
    )
    client.login("admin", "not-a-real-password")
    with pytest.raises(ApiError) as error:
        client.change_account_status(
            "00000000-0000-4000-8000-000000000020",
            "upload_only",  # type: ignore[arg-type]
            "OPERATOR_REQUEST",
        )
    assert error.value.code == "INVALID_ACCOUNT_STATUS_TARGET"


def test_activity_query_keeps_bounded_filters_separate_from_domain_audit() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v1/auth/login"):
            return httpx.Response(200, json=login_response())
        if request.url.path.endswith("/v1/developer/activity-events"):
            observed.append(request)
            return httpx.Response(200, json={"events": [], "nextCursor": None})
        raise AssertionError(request.url.path)

    client = BackendApiClient(config(), transport=transport(handler))
    client.login("admin", "not-a-real-password")
    page = client.developer_activity_events(
        role="maid",
        categories=("authorization",),
        event_types=("authorization.denied",),
        outcomes=("denied",),
        limit=100,
    )

    assert page == {"events": [], "nextCursor": None}
    query = observed[0].url.params
    assert query["role"] == "maid"
    assert query["category"] == "authorization"
    assert query["eventType"] == "authorization.denied"
    assert query["outcome"] == "denied"
    assert query["limit"] == "100"
