from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperOverviewAccountsByRole")


@_attrs_define
class DeveloperOverviewAccountsByRole:
    """
    Attributes:
        developer (int):
        admin (int):
        maid (int):
    """

    developer: int
    admin: int
    maid: int

    def to_dict(self) -> dict[str, Any]:
        developer = self.developer

        admin = self.admin

        maid = self.maid

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "developer": developer,
                "admin": admin,
                "maid": maid,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        developer = d.pop("developer")

        admin = d.pop("admin")

        maid = d.pop("maid")

        developer_overview_accounts_by_role = cls(
            developer=developer,
            admin=admin,
            maid=maid,
        )

        return developer_overview_accounts_by_role
