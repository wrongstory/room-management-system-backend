from __future__ import annotations

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
    list_developer_audit_events,
    run_developer_diagnostics,
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
        list_developer_audit_events.sync_detailed,
        run_developer_diagnostics.sync_detailed,
    ]
    assert len(operations) == 14
