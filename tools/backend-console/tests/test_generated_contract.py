from __future__ import annotations

import pkgutil
from importlib import import_module

from attrs import fields

from room_management_console.generated.api.accounts import (
    change_account_role,
    change_account_status,
    create_account,
    list_accounts,
    reset_account_password,
    unlock_account,
)
from room_management_console.generated.api.auth import change_password, get_current_user, login
from room_management_console.generated.api.developer import (
    get_developer_database_status,
    get_developer_overview,
    get_developer_runtime_status,
    get_developer_scheduler_status,
    list_developer_activity_events,
    list_developer_audit_events,
    run_developer_diagnostics,
)
from room_management_console.generated.models.account_status import AccountStatus
from room_management_console.generated.models.developer_audit_event_summary import (
    DeveloperAuditEventSummary,
)
from room_management_console.generated.models.developer_audit_event_type import (
    DeveloperAuditEventType,
)
from room_management_console.generated.models.status_change_request_status import (
    StatusChangeRequestStatus,
)


def test_phase_a_openapi_operations_are_generated() -> None:
    operations = [
        login.sync_detailed,
        get_current_user.sync_detailed,
        change_password.sync_detailed,
        list_accounts.sync_detailed,
        create_account.sync_detailed,
        change_account_role.sync_detailed,
        change_account_status.sync_detailed,
        unlock_account.sync_detailed,
        reset_account_password.sync_detailed,
        get_developer_overview.sync_detailed,
        get_developer_runtime_status.sync_detailed,
        get_developer_database_status.sync_detailed,
        get_developer_scheduler_status.sync_detailed,
        list_developer_activity_events.sync_detailed,
        list_developer_audit_events.sync_detailed,
        run_developer_diagnostics.sync_detailed,
    ]
    assert len(operations) == 16


def test_account_response_and_status_command_use_distinct_enums() -> None:
    assert {status.value for status in AccountStatus} == {
        "active",
        "deactivation_pending",
        "upload_only",
        "inactive",
        "departed",
    }
    assert {status.value for status in StatusChangeRequestStatus} == {
        "active",
        "inactive",
        "departed",
    }


def test_assignment_audit_contract_is_generated_without_raw_state() -> None:
    assert DeveloperAuditEventType.ASSIGNMENT_DRAFT_SAVED.value == "assignment.draft_saved"
    assert DeveloperAuditEventType.ASSIGNMENT_NOTIFIED.value == "assignment.notified"
    assert {
        "assignment.prestart_changed",
        "assignment.prestart_unassigned",
        "assignment.cancellation_requested",
        "assignment.cancellation_decided",
        "assignment.attempt_activated",
        "assignment.rolled_over",
        "assignment.duration_policy_confirmed",
    } <= {event.value for event in DeveloperAuditEventType}
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {
        "policy_version",
        "standard_minutes",
        "premium_minutes",
        "ocean_premium_minutes",
        "ocean_family_minutes",
    } <= field_names
    assert {
        "assignment_id",
        "cleaning_target_id",
        "maid_profile_id",
        "service_date",
        "sequence_number",
        "revision",
        "target_assignment_version",
        "previous_assignment_id",
        "previous_maid_profile_id",
        "request_id",
        "decision",
        "reason_code",
        "attempt_id",
        "attempt_number",
        "assignment_revision",
        "rollover_from_date",
        "rollover_to_date",
        "carryover_count",
    } <= field_names
    assert {"request_hash", "reason_detail", "before_state", "after_state"}.isdisjoint(field_names)


def test_attempt_lifecycle_audit_contract_preserves_only_safe_generated_fields() -> None:
    assert {
        "cleaning.finish_current_allowed",
        "cleaning.upload_only_allowed",
        "cleaning.interrupted_handover",
        "cleaning.scheduled_expired",
    } <= {event.value for event in DeveloperAuditEventType}
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {
        "capability_kind",
        "expires_at",
        "profile_status",
        "profile_version",
        "next_attempt_id",
    } <= field_names
    assert {
        "before_state",
        "after_state",
        "raw_before_state",
        "raw_after_state",
        "request_hash",
        "request_body",
        "session_id",
        "session_token",
        "token",
        "access_token",
        "refresh_token",
        "authorization",
        "password",
        "secret",
    }.isdisjoint(field_names)
    safe_summary = {
        "capabilityKind": "upload_submit",
        "expiresAt": "2026-09-09T03:00:00+00:00",
        "profileStatus": "upload_only",
        "profileVersion": 2,
        "nextAttemptId": "10000000-0000-4000-8000-000000000001",
    }
    assert DeveloperAuditEventSummary.from_dict(safe_summary).to_dict() == safe_summary
    # 만료된 미착수 이력 정리는 비활성 계정을 재활성화하지 않는다.
    for profile_status in ("inactive", "departed"):
        expired_summary = {
            "attemptId": "10000000-0000-4000-8000-000000000001",
            "status": "superseded",
            "profileStatus": profile_status,
            "profileVersion": 3,
            "endedAt": "2026-09-08T03:00:00+00:00",
        }
        assert DeveloperAuditEventSummary.from_dict(expired_summary).to_dict() == expired_summary


def test_phase_a_generated_client_contains_only_sixteen_authorized_operations() -> None:
    from room_management_console.generated import api

    generated_groups = {module.name for module in pkgutil.iter_modules(api.__path__)}
    assert generated_groups == {"auth", "accounts", "developer"}
    operation_names = set()
    for group in generated_groups:
        group_module = import_module(f"{api.__name__}.{group}")
        for operation in pkgutil.iter_modules(group_module.__path__):
            assert not operation.ispkg
            operation_names.add(f"{group}.{operation.name}")
    assert operation_names == {
        "auth.login",
        "auth.get_current_user",
        "auth.change_password",
        "accounts.list_accounts",
        "accounts.create_account",
        "accounts.change_account_role",
        "accounts.change_account_status",
        "accounts.unlock_account",
        "accounts.reset_account_password",
        "developer.get_developer_overview",
        "developer.get_developer_runtime_status",
        "developer.get_developer_database_status",
        "developer.get_developer_scheduler_status",
        "developer.list_developer_activity_events",
        "developer.list_developer_audit_events",
        "developer.run_developer_diagnostics",
    }
