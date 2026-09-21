from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_type_catalog_item import DeveloperRoomTypeCatalogItem


T = TypeVar("T", bound="DeveloperRoomTypeCapacityChange")


@_attrs_define
class DeveloperRoomTypeCapacityChange:
    """
    Attributes:
        room_type (DeveloperRoomTypeCatalogItem):
        effective_at (datetime.datetime):
    """

    room_type: DeveloperRoomTypeCatalogItem
    effective_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        room_type = self.room_type.to_dict()

        effective_at = self.effective_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomType": room_type,
                "effectiveAt": effective_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_type_catalog_item import DeveloperRoomTypeCatalogItem

        d = dict(src_dict)
        room_type = DeveloperRoomTypeCatalogItem.from_dict(d.pop("roomType"))

        effective_at = datetime.datetime.fromisoformat(d.pop("effectiveAt"))

        developer_room_type_capacity_change = cls(
            room_type=room_type,
            effective_at=effective_at,
        )

        return developer_room_type_capacity_change
