from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomTypeCapacityPreviewRequest")


@_attrs_define
class DeveloperRoomTypeCapacityPreviewRequest:
    """baseOccupancy는 maxOccupancy 이하여야 합니다.

    Attributes:
        base_occupancy (int):
        max_occupancy (int):
        expected_version (int):
    """

    base_occupancy: int
    max_occupancy: int
    expected_version: int

    def to_dict(self) -> dict[str, Any]:
        base_occupancy = self.base_occupancy

        max_occupancy = self.max_occupancy

        expected_version = self.expected_version

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "baseOccupancy": base_occupancy,
                "maxOccupancy": max_occupancy,
                "expectedVersion": expected_version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        base_occupancy = d.pop("baseOccupancy")

        max_occupancy = d.pop("maxOccupancy")

        expected_version = d.pop("expectedVersion")

        developer_room_type_capacity_preview_request = cls(
            base_occupancy=base_occupancy,
            max_occupancy=max_occupancy,
            expected_version=expected_version,
        )

        return developer_room_type_capacity_preview_request
