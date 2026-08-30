from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.app_role import AppRole

T = TypeVar("T", bound="Actor")


@_attrs_define
class Actor:
    """
    Attributes:
        auth_user_id (UUID): Supabase Auth 사용자 ID입니다. 화면 엔티티 연결에는 profileId를 우선 사용합니다.
        profile_id (UUID): 앱 전 영역에서 사용하는 불변 사용자 ID
        display_name (str): 현재 화면 표시 이름
        role (AppRole): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        must_change_password (bool): true이면 비밀번호 변경과 현재 사용자 확인 외 업무 화면을 차단합니다.
    """

    auth_user_id: UUID
    profile_id: UUID
    display_name: str
    role: AppRole
    must_change_password: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        auth_user_id = str(self.auth_user_id)

        profile_id = str(self.profile_id)

        display_name = self.display_name

        role = self.role.value

        must_change_password = self.must_change_password

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "authUserId": auth_user_id,
                "profileId": profile_id,
                "displayName": display_name,
                "role": role,
                "mustChangePassword": must_change_password,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        auth_user_id = UUID(d.pop("authUserId"))

        profile_id = UUID(d.pop("profileId"))

        display_name = d.pop("displayName")

        role = AppRole(d.pop("role"))

        must_change_password = d.pop("mustChangePassword")

        actor = cls(
            auth_user_id=auth_user_id,
            profile_id=profile_id,
            display_name=display_name,
            role=role,
            must_change_password=must_change_password,
        )

        actor.additional_properties = d
        return actor

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
