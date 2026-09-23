from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomCatalogSummary")


@_attrs_define
class DeveloperRoomCatalogSummary:
    """
    Attributes:
        total (int):
        active (int):
        inactive (int):
    """

    total: int
    active: int
    inactive: int

    def to_dict(self) -> dict[str, Any]:
        total = self.total

        active = self.active

        inactive = self.inactive

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "total": total,
                "active": active,
                "inactive": inactive,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        total = d.pop("total")

        active = d.pop("active")

        inactive = d.pop("inactive")

        developer_room_catalog_summary = cls(
            total=total,
            active=active,
            inactive=inactive,
        )

        return developer_room_catalog_summary
