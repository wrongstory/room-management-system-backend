from __future__ import annotations

import pkgutil

from attrs import fields

from room_management_console.generated.api.accounts import (
    change_account_role,
    change_account_status,
    create_account,
    list_accounts,
    reset_account_password,
    unlock_account,
)
from room_management_console.generated.api.auth import get_current_user, login
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
    assert len(operations) == 15


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
    field_names = {field.name for field in fields(DeveloperAuditEventSummary)}
    assert {
        "assignment_id",
        "cleaning_target_id",
        "maid_profile_id",
        "service_date",
        "sequence_number",
        "revision",
        "target_assignment_version",
    } <= field_names
    assert {"request_hash", "before_state", "after_state"}.isdisjoint(field_names)


def test_phase_a_generated_client_excludes_business_reservation_api() -> None:
    from room_management_console.generated import api

    generated_groups = {module.name for module in pkgutil.iter_modules(api.__path__)}
    assert "reservations" not in generated_groups
