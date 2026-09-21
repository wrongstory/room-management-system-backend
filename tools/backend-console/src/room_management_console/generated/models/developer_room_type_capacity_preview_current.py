from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomTypeCapacityPreviewCurrent")


@_attrs_define
class DeveloperRoomTypeCapacityPreviewCurrent:
    """
    Attributes:
        base_occupancy (int):
        max_occupancy (int):
        version (int):
    """

    base_occupancy: int
    max_occupancy: int
    version: int

    def to_dict(self) -> dict[str, Any]:
        base_occupancy = self.base_occupancy

        max_occupancy = self.max_occupancy

        version = self.version

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "baseOccupancy": base_occupancy,
                "maxOccupancy": max_occupancy,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        base_occupancy = d.pop("baseOccupancy")

        max_occupancy = d.pop("maxOccupancy")

        version = d.pop("version")

        developer_room_type_capacity_preview_current = cls(
            base_occupancy=base_occupancy,
            max_occupancy=max_occupancy,
            version=version,
        )

        return developer_room_type_capacity_preview_current
