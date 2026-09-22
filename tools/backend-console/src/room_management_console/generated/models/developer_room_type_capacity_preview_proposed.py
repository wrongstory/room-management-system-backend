from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomTypeCapacityPreviewProposed")


@_attrs_define
class DeveloperRoomTypeCapacityPreviewProposed:
    """
    Attributes:
        base_occupancy (int):
        max_occupancy (int):
    """

    base_occupancy: int
    max_occupancy: int

    def to_dict(self) -> dict[str, Any]:
        base_occupancy = self.base_occupancy

        max_occupancy = self.max_occupancy

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "baseOccupancy": base_occupancy,
                "maxOccupancy": max_occupancy,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        base_occupancy = d.pop("baseOccupancy")

        max_occupancy = d.pop("maxOccupancy")

        developer_room_type_capacity_preview_proposed = cls(
            base_occupancy=base_occupancy,
            max_occupancy=max_occupancy,
        )

        return developer_room_type_capacity_preview_proposed
