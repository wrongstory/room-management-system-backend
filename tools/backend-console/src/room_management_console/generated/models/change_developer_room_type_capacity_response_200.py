from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_type_capacity_change import DeveloperRoomTypeCapacityChange


T = TypeVar("T", bound="ChangeDeveloperRoomTypeCapacityResponse200")


@_attrs_define
class ChangeDeveloperRoomTypeCapacityResponse200:
    """
    Attributes:
        change (DeveloperRoomTypeCapacityChange):
    """

    change: DeveloperRoomTypeCapacityChange

    def to_dict(self) -> dict[str, Any]:
        change = self.change.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "change": change,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_type_capacity_change import DeveloperRoomTypeCapacityChange

        d = dict(src_dict)
        change = DeveloperRoomTypeCapacityChange.from_dict(d.pop("change"))

        change_developer_room_type_capacity_response_200 = cls(
            change=change,
        )

        return change_developer_room_type_capacity_response_200
