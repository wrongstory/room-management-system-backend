from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.room_type_catalog_item import RoomTypeCatalogItem


T = TypeVar("T", bound="RoomTypeCatalogEnvelope")


@_attrs_define
class RoomTypeCatalogEnvelope:
    """
    Attributes:
        items (list[RoomTypeCatalogItem]):
    """

    items: list[RoomTypeCatalogItem]

    def to_dict(self) -> dict[str, Any]:
        items = []
        for items_item_data in self.items:
            items_item = items_item_data.to_dict()
            items.append(items_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "items": items,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.room_type_catalog_item import RoomTypeCatalogItem

        d = dict(src_dict)
        items = []
        _items = d.pop("items")
        for items_item_data in _items:
            items_item = RoomTypeCatalogItem.from_dict(items_item_data)

            items.append(items_item)

        room_type_catalog_envelope = cls(
            items=items,
        )

        return room_type_catalog_envelope
