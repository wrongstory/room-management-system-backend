from __future__ import annotations

from room_management_console.models import Account
from room_management_console.policies import account_action_policy


def account(*, role: str, status: str = "active", failed: int = 0) -> Account:
    return Account.from_dict(
        {
            "id": "00000000-0000-4000-8000-000000000001",
            "displayName": "테스트 계정",
            "loginId": "test-user",
            "role": role,
            "status": status,
            "phoneLastFour": "0000",
            "mustChangePassword": False,
            "failedLoginCount": failed,
            "lockedUntil": None,
            "createdAt": "2026-08-31T00:00:00Z",
            "updatedAt": "2026-08-31T00:00:00Z",
        }
    )


def test_developer_account_actions_are_all_blocked() -> None:
    policy = account_action_policy(account(role="developer"), active_admin_count=1)
    assert not policy.can_change_role
    assert not policy.can_change_status
    assert not policy.can_unlock
    assert not policy.can_reset_password


def test_last_active_business_admin_role_and_status_are_blocked() -> None:
    policy = account_action_policy(account(role="admin"), active_admin_count=1)
    assert not policy.can_change_role
    assert not policy.can_change_status
    assert policy.warning is not None


def test_maid_unlock_is_available_after_login_failures() -> None:
    policy = account_action_policy(account(role="maid", failed=5), active_admin_count=1)
    assert policy.can_unlock
    assert policy.can_reset_password
