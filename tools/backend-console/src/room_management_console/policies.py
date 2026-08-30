from __future__ import annotations

from dataclasses import dataclass

from .models import Account


@dataclass(frozen=True, slots=True)
class AccountActionPolicy:
    can_change_role: bool
    can_change_status: bool
    can_unlock: bool
    can_reset_password: bool
    warning: str | None = None


def account_action_policy(account: Account, active_admin_count: int) -> AccountActionPolicy:
    if account.role == "developer":
        return AccountActionPolicy(False, False, False, False, "developer 계정은 보호됩니다.")
    last_admin = account.role == "admin" and account.status == "active" and active_admin_count <= 1
    return AccountActionPolicy(
        can_change_role=not last_admin,
        can_change_status=not last_admin,
        can_unlock=account.failed_login_count > 0 or account.locked_until is not None,
        can_reset_password=account.phone_last_four is not None,
        warning="마지막 active business admin은 역할·상태를 변경할 수 없습니다."
        if last_admin
        else None,
    )
