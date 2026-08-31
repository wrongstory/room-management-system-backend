from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic
from typing import Any, Literal

Environment = Literal["production", "recovery", "local"]
Role = Literal["developer", "admin", "maid"]
AccountStatus = Literal[
    "active",
    "deactivation_pending",
    "upload_only",
    "inactive",
    "departed",
]
AccountStatusTarget = Literal["active", "inactive", "departed"]
ACCOUNT_STATUS_TARGETS = frozenset({"active", "inactive", "departed"})
TRANSITIONAL_ACCOUNT_STATUSES = frozenset({"deactivation_pending", "upload_only"})


@dataclass(frozen=True, slots=True)
class Actor:
    auth_user_id: str
    profile_id: str
    display_name: str
    role: Role
    must_change_password: bool

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Actor:
        role = value.get("role")
        if role not in {"developer", "admin", "maid"}:
            raise ValueError("지원하지 않는 사용자 역할입니다.")
        return cls(
            auth_user_id=str(value["authUserId"]),
            profile_id=str(value["profileId"]),
            display_name=str(value["displayName"]),
            role=role,
            must_change_password=bool(value["mustChangePassword"]),
        )


@dataclass(frozen=True, slots=True)
class Account:
    id: str
    display_name: str
    login_id: str
    role: Role
    status: AccountStatus
    phone_last_four: str | None
    must_change_password: bool
    failed_login_count: int
    locked_until: str | None
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Account:
        role = value.get("role")
        status = value.get("status")
        if role not in {"developer", "admin", "maid"}:
            raise ValueError("지원하지 않는 계정 역할입니다.")
        if status not in ACCOUNT_STATUS_TARGETS | TRANSITIONAL_ACCOUNT_STATUSES:
            raise ValueError("지원하지 않는 계정 상태입니다.")
        return cls(
            id=str(value["id"]),
            display_name=str(value["displayName"]),
            login_id=str(value["loginId"]),
            role=role,
            status=status,
            phone_last_four=(
                str(value["phoneLastFour"]) if value.get("phoneLastFour") is not None else None
            ),
            must_change_password=bool(value["mustChangePassword"]),
            failed_login_count=int(value["failedLoginCount"]),
            locked_until=str(value["lockedUntil"]) if value.get("lockedUntil") else None,
            created_at=str(value["createdAt"]),
            updated_at=str(value["updatedAt"]),
        )


@dataclass(slots=True)
class MemorySession:
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at_monotonic: float
    actor: Actor

    @classmethod
    def create(
        cls,
        *,
        access_token: str,
        refresh_token: str,
        expires_in: int,
        actor: Actor,
    ) -> MemorySession:
        return cls(access_token, refresh_token, monotonic() + expires_in, actor)

    def expires_within(self, seconds: int) -> bool:
        return self.expires_at_monotonic <= monotonic() + seconds

    def clear(self) -> None:
        self.access_token = ""
        self.refresh_token = ""
        self.expires_at_monotonic = 0


@dataclass(frozen=True, slots=True)
class CommandReceipt:
    scope: str
    request_hash: str
    idempotency_key: str
