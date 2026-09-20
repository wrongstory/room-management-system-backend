from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem


T = TypeVar("T", bound="RetireDeveloperRoomResponse200")


@_attrs_define
class RetireDeveloperRoomResponse200:
    """
    Attributes:
        room (DeveloperRoomCatalogItem):
    """

    room: DeveloperRoomCatalogItem

    def to_dict(self) -> dict[str, Any]:
        room = self.room.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "room": room,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem

        d = dict(src_dict)
        room = DeveloperRoomCatalogItem.from_dict(d.pop("room"))

        retire_developer_room_response_200 = cls(
            room=room,
        )

        return retire_developer_room_response_200
