from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomCatalogPageCounts")


@_attrs_define
class DeveloperRoomCatalogPageCounts:
    """
    Attributes:
        active (int):
        retired (int):
        total (int):
    """

    active: int
    retired: int
    total: int

    def to_dict(self) -> dict[str, Any]:
        active = self.active

        retired = self.retired

        total = self.total

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "active": active,
                "retired": retired,
                "total": total,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        active = d.pop("active")

        retired = d.pop("retired")

        total = d.pop("total")

        developer_room_catalog_page_counts = cls(
            active=active,
            retired=retired,
            total=total,
        )

        return developer_room_catalog_page_counts
