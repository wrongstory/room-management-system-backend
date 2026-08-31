from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.managed_role import ManagedRole

T = TypeVar("T", bound="RoleChangeRequest")


@_attrs_define
class RoleChangeRequest:
    """
    Attributes:
        role (ManagedRole): 일반 계정 API에서 생성·변경할 수 있는 역할입니다. developer는 허용되지 않습니다.
    """

    role: ManagedRole

    def to_dict(self) -> dict[str, Any]:
        role = self.role.value

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "role": role,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        role = ManagedRole(d.pop("role"))

        role_change_request = cls(
            role=role,
        )

        return role_change_request
