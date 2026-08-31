from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_overview_accounts_by_role import DeveloperOverviewAccountsByRole


T = TypeVar("T", bound="DeveloperOverviewAccounts")


@_attrs_define
class DeveloperOverviewAccounts:
    """
    Attributes:
        total (int):
        active (int):
        by_role (DeveloperOverviewAccountsByRole):
    """

    total: int
    active: int
    by_role: DeveloperOverviewAccountsByRole

    def to_dict(self) -> dict[str, Any]:
        total = self.total

        active = self.active

        by_role = self.by_role.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "total": total,
                "active": active,
                "byRole": by_role,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_overview_accounts_by_role import DeveloperOverviewAccountsByRole

        d = dict(src_dict)
        total = d.pop("total")

        active = d.pop("active")

        by_role = DeveloperOverviewAccountsByRole.from_dict(d.pop("byRole"))

        developer_overview_accounts = cls(
            total=total,
            active=active,
            by_role=by_role,
        )

        return developer_overview_accounts
