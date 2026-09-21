from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem
    from ..models.developer_room_catalog_summary import DeveloperRoomCatalogSummary
    from ..models.developer_room_type_catalog_item import DeveloperRoomTypeCatalogItem


T = TypeVar("T", bound="DeveloperRoomCatalog")


@_attrs_define
class DeveloperRoomCatalog:
    """
    Attributes:
        generated_at (datetime.datetime):
        summary (DeveloperRoomCatalogSummary):
        room_types (list[DeveloperRoomTypeCatalogItem]):
        rooms (list[DeveloperRoomCatalogItem]):
    """

    generated_at: datetime.datetime
    summary: DeveloperRoomCatalogSummary
    room_types: list[DeveloperRoomTypeCatalogItem]
    rooms: list[DeveloperRoomCatalogItem]

    def to_dict(self) -> dict[str, Any]:
        generated_at = self.generated_at.isoformat()

        summary = self.summary.to_dict()

        room_types = []
        for room_types_item_data in self.room_types:
            room_types_item = room_types_item_data.to_dict()
            room_types.append(room_types_item)

        rooms = []
        for rooms_item_data in self.rooms:
            rooms_item = rooms_item_data.to_dict()
            rooms.append(rooms_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "generatedAt": generated_at,
                "summary": summary,
                "roomTypes": room_types,
                "rooms": rooms,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem
        from ..models.developer_room_catalog_summary import DeveloperRoomCatalogSummary
        from ..models.developer_room_type_catalog_item import DeveloperRoomTypeCatalogItem

        d = dict(src_dict)
        generated_at = datetime.datetime.fromisoformat(d.pop("generatedAt"))

        summary = DeveloperRoomCatalogSummary.from_dict(d.pop("summary"))

        room_types = []
        _room_types = d.pop("roomTypes")
        for room_types_item_data in _room_types:
            room_types_item = DeveloperRoomTypeCatalogItem.from_dict(room_types_item_data)

            room_types.append(room_types_item)

        rooms = []
        _rooms = d.pop("rooms")
        for rooms_item_data in _rooms:
            rooms_item = DeveloperRoomCatalogItem.from_dict(rooms_item_data)

            rooms.append(rooms_item)

        developer_room_catalog = cls(
            generated_at=generated_at,
            summary=summary,
            room_types=room_types,
            rooms=rooms,
        )

        return developer_room_catalog
