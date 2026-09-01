from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.managed_role import ManagedRole

T = TypeVar("T", bound="CreateAccountRequest")


@_attrs_define
class CreateAccountRequest:
    """
    Attributes:
        display_name (str): 화면 표시 이름. 동명이인은 서버가 안정적인 login ID suffix로 구분합니다.
        role (ManagedRole): 일반 계정 API에서 생성·변경할 수 있는 역할입니다. developer는 허용되지 않습니다.
        phone (str): 010으로 시작하는 국내 휴대전화 번호. 하이픈은 허용하지만 요청 처리 중에만 사용하며 원문을 응답·로그·감사 원장에 저장하지 않습니다.
    """

    display_name: str
    role: ManagedRole
    phone: str

    def to_dict(self) -> dict[str, Any]:
        display_name = self.display_name

        role = self.role.value

        phone = self.phone

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "displayName": display_name,
                "role": role,
                "phone": phone,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        display_name = d.pop("displayName")

        role = ManagedRole(d.pop("role"))

        phone = d.pop("phone")

        create_account_request = cls(
            display_name=display_name,
            role=role,
            phone=phone,
        )

        return create_account_request
