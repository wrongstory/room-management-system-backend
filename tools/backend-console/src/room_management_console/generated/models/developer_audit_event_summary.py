from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.account_status import AccountStatus
from ..models.app_role import AppRole
from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperAuditEventSummary")


@_attrs_define
class DeveloperAuditEventSummary:
    """이벤트별 displayName/loginId/role/status/mustChangePassword 허용 필드만 포함

    Attributes:
        display_name (str | Unset):
        login_id (str | Unset):
        role (AppRole | Unset): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        status (AccountStatus | Unset): 프론트가 직접 설정할 수 있는 값은 active, inactive, departed입니다. deactivation_pending과
            upload_only는 서버가 제한 capability를 나타낼 때만 반환합니다.
        must_change_password (bool | Unset):
    """

    display_name: str | Unset = UNSET
    login_id: str | Unset = UNSET
    role: AppRole | Unset = UNSET
    status: AccountStatus | Unset = UNSET
    must_change_password: bool | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        display_name = self.display_name

        login_id = self.login_id

        role: str | Unset = UNSET
        if not isinstance(self.role, Unset):
            role = self.role.value

        status: str | Unset = UNSET
        if not isinstance(self.status, Unset):
            status = self.status.value

        must_change_password = self.must_change_password

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if display_name is not UNSET:
            field_dict["displayName"] = display_name
        if login_id is not UNSET:
            field_dict["loginId"] = login_id
        if role is not UNSET:
            field_dict["role"] = role
        if status is not UNSET:
            field_dict["status"] = status
        if must_change_password is not UNSET:
            field_dict["mustChangePassword"] = must_change_password

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        display_name = d.pop("displayName", UNSET)

        login_id = d.pop("loginId", UNSET)

        _role = d.pop("role", UNSET)
        role: AppRole | Unset
        if isinstance(_role, Unset):
            role = UNSET
        else:
            role = AppRole(_role)

        _status = d.pop("status", UNSET)
        status: AccountStatus | Unset
        if isinstance(_status, Unset):
            status = UNSET
        else:
            status = AccountStatus(_status)

        must_change_password = d.pop("mustChangePassword", UNSET)

        developer_audit_event_summary = cls(
            display_name=display_name,
            login_id=login_id,
            role=role,
            status=status,
            must_change_password=must_change_password,
        )

        return developer_audit_event_summary
