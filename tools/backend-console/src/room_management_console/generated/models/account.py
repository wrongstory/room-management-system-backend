from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.account_status import AccountStatus
from ..models.app_role import AppRole

T = TypeVar("T", bound="Account")


@_attrs_define
class Account:
    """
    Attributes:
        id (UUID): profile ID. 계정 변경 path의 profileId로 사용합니다.
        display_name (str): 현재 표시 이름
        login_id (str): 현재 로그인 ID. 별도 ID 변경 기능은 제공하지 않습니다.
        role (AppRole): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        status (AccountStatus): 프론트가 직접 설정할 수 있는 값은 active, inactive, departed입니다. deactivation_pending과 upload_only는
            서버가 제한 capability를 나타낼 때만 반환합니다.
        phone_last_four (None | str): 비밀번호 초기화 가능 여부 확인용 마지막 4자리. 전체 번호는 반환하지 않습니다.
        must_change_password (bool): 다음 로그인에서 개인 비밀번호 변경이 필요한지 여부
        failed_login_count (int): 현재 연속 로그인 실패 횟수
        locked_until (datetime.datetime | None): 로그인 잠금 종료 시각. 잠금이 없으면 null
        created_at (datetime.datetime): 계정 생성 시각
        updated_at (datetime.datetime): 현재 계정 projection 갱신 시각
    """

    id: UUID
    display_name: str
    login_id: str
    role: AppRole
    status: AccountStatus
    phone_last_four: None | str
    must_change_password: bool
    failed_login_count: int
    locked_until: datetime.datetime | None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        display_name = self.display_name

        login_id = self.login_id

        role = self.role.value

        status = self.status.value

        phone_last_four: None | str
        phone_last_four = self.phone_last_four

        must_change_password = self.must_change_password

        failed_login_count = self.failed_login_count

        locked_until: None | str
        if isinstance(self.locked_until, datetime.datetime):
            locked_until = self.locked_until.isoformat()
        else:
            locked_until = self.locked_until

        created_at = self.created_at.isoformat()

        updated_at = self.updated_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "displayName": display_name,
                "loginId": login_id,
                "role": role,
                "status": status,
                "phoneLastFour": phone_last_four,
                "mustChangePassword": must_change_password,
                "failedLoginCount": failed_login_count,
                "lockedUntil": locked_until,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        display_name = d.pop("displayName")

        login_id = d.pop("loginId")

        role = AppRole(d.pop("role"))

        status = AccountStatus(d.pop("status"))

        def _parse_phone_last_four(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        phone_last_four = _parse_phone_last_four(d.pop("phoneLastFour"))

        must_change_password = d.pop("mustChangePassword")

        failed_login_count = d.pop("failedLoginCount")

        def _parse_locked_until(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                locked_until_type_0 = datetime.datetime.fromisoformat(data)

                return locked_until_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        locked_until = _parse_locked_until(d.pop("lockedUntil"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        updated_at = datetime.datetime.fromisoformat(d.pop("updatedAt"))

        account = cls(
            id=id,
            display_name=display_name,
            login_id=login_id,
            role=role,
            status=status,
            phone_last_four=phone_last_four,
            must_change_password=must_change_password,
            failed_login_count=failed_login_count,
            locked_until=locked_until,
            created_at=created_at,
            updated_at=updated_at,
        )

        account.additional_properties = d
        return account

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
