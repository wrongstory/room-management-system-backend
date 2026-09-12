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
from room_management_console.generated.models import (
    DeveloperDatabaseStatusNotificationDelivery,
    DeveloperDatabaseStatusNotificationDeliveryBacklog,
)
from room_management_console.generated.models.account_status import AccountStatus
from room_management_console.generated.models.developer_audit_event_summary import (
    DeveloperAuditEventSummary,
)
from room_management_console.generated.models.developer_audit_event_type import (
    DeveloperAuditEventType,
)
from room_management_console.generated.models.developer_database_status import (
    DeveloperDatabaseStatus,
)
from room_management_console.generated.models.developer_database_status_photo_purge import (
    DeveloperDatabaseStatusPhotoPurge,
)
from room_management_console.generated.models.developer_database_status_photo_purge_status import (
    DeveloperDatabaseStatusPhotoPurgeStatus,
)
from room_management_console.generated.models.developer_runtime_status_configuration import (
    DeveloperRuntimeStatusConfiguration,
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


def test_photo_purge_status_is_generated_as_bounded_metadata_only() -> None:
    assert "photo_purge" in {field.name for field in fields(DeveloperDatabaseStatus)}
    assert {"status", "last_heartbeat", "backlog", "checked_at"} <= {
        field.name for field in fields(DeveloperDatabaseStatusPhotoPurge)
    }
    assert {status.value for status in DeveloperDatabaseStatusPhotoPurgeStatus} == {
        "awaiting_first_run",
        "healthy",
        "degraded",
        "failed",
    }
    configuration_fields = {field.name for field in fields(DeveloperRuntimeStatusConfiguration)}
    assert "photo_purge_invoke_secret" in configuration_fields
    assert {
        "provider_file_id",
        "provider_folder_id",
        "claim_digest",
        "refresh_token",
    }.isdisjoint(configuration_fields)


def test_notification_delivery_status_is_generated_as_bounded_metadata_only() -> None:
    assert "notification_delivery" in {field.name for field in fields(DeveloperDatabaseStatus)}
    assert {"status", "last_heartbeat", "backlog", "activation", "checked_at"} == {
        field.name for field in fields(DeveloperDatabaseStatusNotificationDelivery)
    }
    assert {
        "due",
        "retrying",
        "dead_letter",
        "job_only_dead_letter",
        "blocked",
        "expired_leases",
        "oldest_due_at",
    } == {field.name for field in fields(DeveloperDatabaseStatusNotificationDeliveryBacklog)}
    exposed = {field.name for field in fields(DeveloperDatabaseStatusNotificationDelivery)} | {
        field.name for field in fields(DeveloperDatabaseStatusNotificationDeliveryBacklog)
    }
    assert {
        "endpoint",
        "endpoint_digest",
        "session_digest",
        "claim_digest",
        "ciphertext",
        "nonce",
        "auth_tag",
        "provider_error",
    }.isdisjoint(exposed)


def test_photo_upload_and_original_read_are_not_developer_console_capabilities() -> None:
    from room_management_console.generated import api

    groups = {entry.name for entry in pkgutil.iter_modules(api.__path__)}
    assert groups == {"accounts", "auth", "developer"}
    assert {"photos", "attempts", "photo_uploads", "payroll", "notifications"}.isdisjoint(groups)


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


def test_offline_resolution_generated_audit_excludes_ninety_day_client_metadata() -> None:
    assert DeveloperAuditEventType.CLEANING_OFFLINE_EVENT_RESOLVED.value == (
        "cleaning.offline_event_resolved"
    )
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {"offline_quarantine_id", "resolution"} <= field_names
    assert {
        "event_id",
        "lease_id",
        "occurred_at",
        "server_offset_ms",
        "request_hash",
        "session_id",
        "request_body",
        "token",
        "pin",
        "guest_name",
    }.isdisjoint(field_names)
    for resolution in ("record_only", "reject_effect", "correction_link"):
        summary = {
            "offlineQuarantineId": "10000000-0000-4000-8000-000000000001",
            "resolution": resolution,
        }
        assert DeveloperAuditEventSummary.from_dict(summary).to_dict() == summary


def test_photo_upload_audit_generated_contract_has_safe_metadata_only() -> None:
    assert DeveloperAuditEventType.PHOTO_UPLOAD_ACCEPTED.value == "photo.upload_accepted"
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {
        "target_slot_id",
        "photo_id",
        "photo_version",
        "uploaded_at",
        "purge_after",
    } <= field_names
    assert {
        "provider_locator",
        "drive_file_id",
        "sha256",
        "request_hash",
        "idempotency_key",
        "idempotency_key_digest",
        "claim_id",
        "claim_digest",
        "session_id",
        "token",
        "raw_before_state",
        "raw_after_state",
    }.isdisjoint(field_names)
    summary = {
        "cleaningTargetId": "10000000-0000-4000-8000-000000000001",
        "attemptId": "10000000-0000-4000-8000-000000000002",
        "targetSlotId": "10000000-0000-4000-8000-000000000003",
        "photoId": "10000000-0000-4000-8000-000000000004",
        "photoVersion": 1,
        "uploadedAt": "2037-01-01T00:00:00+00:00",
        "purgeAfter": "2037-01-08T00:00:00+00:00",
    }
    assert DeveloperAuditEventSummary.from_dict(summary).to_dict() == summary


def test_submission_inspection_audit_generated_contract_has_safe_metadata_only() -> None:
    assert {
        DeveloperAuditEventType.SUBMISSION_BOMB_REPORTED.value,
        DeveloperAuditEventType.SUBMISSION_CREATED.value,
        DeveloperAuditEventType.INSPECTION_BOMB_DECIDED.value,
        DeveloperAuditEventType.INSPECTION_APPROVED.value,
        DeveloperAuditEventType.INSPECTION_REJECTED.value,
    } == {
        "submission.bomb_reported",
        "submission.created",
        "inspection.bomb_decided",
        "inspection.approved",
        "inspection.rejected",
    }
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {
        "attempt_id",
        "submission_id",
        "bomb_report_id",
        "earning_id",
        "reclean_target_id",
        "evidence_count",
        "photo_count",
        "decision",
    } <= field_names
    assert {
        "memo",
        "evidence_photo_ids",
        "provider_locator",
        "drive_file_id",
        "sha256",
        "request_hash",
        "idempotency_key",
        "before_state",
        "after_state",
        "guest_name",
        "pin",
        "phone",
        "token",
    }.isdisjoint(field_names)
    summary = {
        "attemptId": "10000000-0000-4000-8000-000000000001",
        "submissionId": "10000000-0000-4000-8000-000000000002",
        "bombReportId": "10000000-0000-4000-8000-000000000003",
        "earningId": "10000000-0000-4000-8000-000000000004",
        "recleanTargetId": "10000000-0000-4000-8000-000000000005",
        "evidenceCount": 2,
        "photoCount": 3,
        "decision": "approved",
    }
    assert DeveloperAuditEventSummary.from_dict(summary).to_dict() == summary


def test_complaint_compensation_audit_generated_contract_is_safe() -> None:
    assert DeveloperAuditEventType.COMPLAINT_REWORK_MATERIALIZED.value == (
        "complaint.rework_materialized"
    )
    assert DeveloperAuditEventType.COMPENSATION_EARNED.value == "compensation.earned"
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {
        "complaint_id",
        "source_complaint_decision_id",
        "compensation_decision_id",
        "rework_cleaning_target_id",
        "inspection_decision_id",
        "same_maid",
        "compensation_amount",
        "amount",
        "currency",
        "case_version",
    } <= field_names
    assert {
        "request_hash",
        "idempotency_key",
        "before_state",
        "after_state",
    }.isdisjoint(field_names)


def test_runtime_secret_configuration_generated_contract_is_boolean_only() -> None:
    from room_management_console.generated.models.developer_runtime_status_configuration import (
        DeveloperRuntimeStatusConfiguration,
    )

    names = [
        "ACCOUNT_PHONE_PEPPER",
        "RESERVATION_PII_KEY_BASE64",
        "RESERVATION_PII_KEY_VERSION",
        "RESERVATION_PII_KEYRING_JSON",
        "RESERVATION_GUEST_NAME_PEPPER",
        "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
        "SCHEDULER_INVOKE_SECRET",
        "CORS_ORIGINS",
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
        "VAPID_PRIVATE_KEY",
        "VAPID_KEYRING_JSON",
        "NOTIFICATION_DELIVERY_INVOKE_SECRET",
    ]
    for configured in [False, True]:
        sample = {name: {"configured": configured} for name in names}
        result = DeveloperRuntimeStatusConfiguration.from_dict(sample).to_dict()
        assert result == sample
        assert all(set(value) == {"configured"} for value in result.values())


def test_payroll_pagination_error_codes_are_generated() -> None:
    from room_management_console.generated.models.error_code import ErrorCode

    assert {
        ErrorCode.PAYROLL_CURSOR_INVALID.value,
        ErrorCode.PAYROLL_CURSOR_NOT_CONFIGURED.value,
        ErrorCode.PAYROLL_PAGE_LIMIT_INVALID.value,
        ErrorCode.PAYROLL_PAGE_KIND_INVALID.value,
        ErrorCode.PAYROLL_RESPONSE_TOO_LARGE.value,
    } == {
        "PAYROLL_CURSOR_INVALID",
        "PAYROLL_CURSOR_NOT_CONFIGURED",
        "PAYROLL_PAGE_LIMIT_INVALID",
        "PAYROLL_PAGE_KIND_INVALID",
        "PAYROLL_RESPONSE_TOO_LARGE",
    }


def test_payroll_adjustment_audit_and_error_codes_are_generated() -> None:
    from room_management_console.generated.models.error_code import ErrorCode

    assert {
        DeveloperAuditEventType.PAYROLL_ADJUSTMENT_RECORDED.value,
        DeveloperAuditEventType.PAYROLL_ADJUSTMENT_REVERSED.value,
        DeveloperAuditEventType.PAYROLL_OFFSET_SETTLED.value,
        DeveloperAuditEventType.PAYROLL_LATE_EARNING_CARRIED.value,
    } == {
        "payroll.adjustment_recorded",
        "payroll.adjustment_reversed",
        "payroll.offset_settled",
        "payroll.late_earning_carried",
    }
    assert {
        ErrorCode.PAYROLL_ADJUSTMENT_INVALID.value,
        ErrorCode.PAYROLL_CYCLE_ECONOMICALLY_FROZEN.value,
        ErrorCode.PAYROLL_EARLIER_CARRY_PENDING.value,
        ErrorCode.PAYROLL_LATE_EARNING_ALREADY_CARRIED.value,
        ErrorCode.PAYROLL_EARNING_NOT_LATE.value,
        ErrorCode.PAYROLL_NONPOSITIVE_REQUIRES_CARRY.value,
        ErrorCode.PAYROLL_PRIOR_LATE_EARNING_PENDING.value,
        ErrorCode.PAYROLL_ROOT_ENTITLEMENT_NEGATIVE.value,
        ErrorCode.PAYROLL_SOURCE_ALREADY_REVERSED.value,
        ErrorCode.PAYROLL_SOURCE_PAYMENT_UNCERTAIN.value,
        ErrorCode.STALE_ADJUSTMENT_VERSION.value,
    } == {
        "PAYROLL_ADJUSTMENT_INVALID",
        "PAYROLL_CYCLE_ECONOMICALLY_FROZEN",
        "PAYROLL_EARLIER_CARRY_PENDING",
        "PAYROLL_LATE_EARNING_ALREADY_CARRIED",
        "PAYROLL_EARNING_NOT_LATE",
        "PAYROLL_NONPOSITIVE_REQUIRES_CARRY",
        "PAYROLL_PRIOR_LATE_EARNING_PENDING",
        "PAYROLL_ROOT_ENTITLEMENT_NEGATIVE",
        "PAYROLL_SOURCE_ALREADY_REVERSED",
        "PAYROLL_SOURCE_PAYMENT_UNCERTAIN",
        "STALE_ADJUSTMENT_VERSION",
    }


def test_payroll_payment_result_audit_and_error_codes_are_generated() -> None:
    from room_management_console.generated.models.error_code import ErrorCode

    assert {
        DeveloperAuditEventType.PAYROLL_PAYMENT_CHECK_RECORDED.value,
        DeveloperAuditEventType.PAYROLL_PAYMENT_PAID.value,
        DeveloperAuditEventType.PAYROLL_PAYMENT_REOPENED.value,
    } == {
        "payroll.payment_check_recorded",
        "payroll.payment_paid",
        "payroll.payment_reopened",
    }
    assert {
        ErrorCode.PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND.value,
        ErrorCode.PAYROLL_PAYMENT_ATTEMPT_TERMINAL.value,
        ErrorCode.PAYROLL_PAYMENT_METHOD_INVALID.value,
        ErrorCode.PAYROLL_PAYMENT_REASON_INVALID.value,
        ErrorCode.PAYROLL_PAYMENT_REFERENCE_ALREADY_USED.value,
        ErrorCode.PAYROLL_PAYMENT_REFERENCE_INVALID.value,
        ErrorCode.PAYROLL_PAYMENT_REOPEN_REASON_INVALID.value,
        ErrorCode.PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH.value,
        ErrorCode.PAYROLL_PAYMENT_TRANSITION_INVALID.value,
    } == {
        "PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND",
        "PAYROLL_PAYMENT_ATTEMPT_TERMINAL",
        "PAYROLL_PAYMENT_METHOD_INVALID",
        "PAYROLL_PAYMENT_REASON_INVALID",
        "PAYROLL_PAYMENT_REFERENCE_ALREADY_USED",
        "PAYROLL_PAYMENT_REFERENCE_INVALID",
        "PAYROLL_PAYMENT_REOPEN_REASON_INVALID",
        "PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH",
        "PAYROLL_PAYMENT_TRANSITION_INVALID",
    }


def test_complaint_rework_error_codes_are_generated() -> None:
    from room_management_console.generated.models.error_code import ErrorCode

    assert {
        ErrorCode.COMPLAINT_COMPENSATION_AMOUNT_INVALID.value,
        ErrorCode.COMPLAINT_REWORK_ALREADY_MATERIALIZED.value,
        ErrorCode.COMPLAINT_REWORK_DECISION_STALE.value,
        ErrorCode.COMPLAINT_REWORK_MAID_UNAVAILABLE.value,
        ErrorCode.COMPLAINT_REWORK_NOT_CONFIRMED.value,
        ErrorCode.COMPLAINT_REWORK_PRESTART_FROZEN.value,
        ErrorCode.COMPLAINT_REWORK_WINDOW_UNAVAILABLE.value,
        ErrorCode.INVALID_COMPLAINT_REWORK.value,
        ErrorCode.RECLEAN_TEMPLATE_NOT_CONFIGURED.value,
    } == {
        "COMPLAINT_COMPENSATION_AMOUNT_INVALID",
        "COMPLAINT_REWORK_ALREADY_MATERIALIZED",
        "COMPLAINT_REWORK_DECISION_STALE",
        "COMPLAINT_REWORK_MAID_UNAVAILABLE",
        "COMPLAINT_REWORK_NOT_CONFIRMED",
        "COMPLAINT_REWORK_PRESTART_FROZEN",
        "COMPLAINT_REWORK_WINDOW_UNAVAILABLE",
        "INVALID_COMPLAINT_REWORK",
        "RECLEAN_TEMPLATE_NOT_CONFIGURED",
    }
