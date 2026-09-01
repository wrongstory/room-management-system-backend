from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperOverviewRooms")


@_attrs_define
class DeveloperOverviewRooms:
    """
    Attributes:
        total (int):
    """

    total: int

    def to_dict(self) -> dict[str, Any]:
        total = self.total

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "total": total,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        total = d.pop("total")

        developer_overview_rooms = cls(
            total=total,
        )

        return developer_overview_rooms
