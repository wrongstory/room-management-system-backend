from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem
    from ..models.developer_room_catalog_page_counts import DeveloperRoomCatalogPageCounts


T = TypeVar("T", bound="DeveloperRoomCatalogPage")


@_attrs_define
class DeveloperRoomCatalogPage:
    """
    Attributes:
        counts (DeveloperRoomCatalogPageCounts):
        items (list[DeveloperRoomCatalogItem]):
        next_cursor (None | str):
    """

    counts: DeveloperRoomCatalogPageCounts
    items: list[DeveloperRoomCatalogItem]
    next_cursor: None | str

    def to_dict(self) -> dict[str, Any]:
        counts = self.counts.to_dict()

        items = []
        for items_item_data in self.items:
            items_item = items_item_data.to_dict()
            items.append(items_item)

        next_cursor: None | str
        next_cursor = self.next_cursor

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "counts": counts,
                "items": items,
                "nextCursor": next_cursor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem
        from ..models.developer_room_catalog_page_counts import DeveloperRoomCatalogPageCounts

        d = dict(src_dict)
        counts = DeveloperRoomCatalogPageCounts.from_dict(d.pop("counts"))

        items = []
        _items = d.pop("items")
        for items_item_data in _items:
            items_item = DeveloperRoomCatalogItem.from_dict(items_item_data)

            items.append(items_item)

        def _parse_next_cursor(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        next_cursor = _parse_next_cursor(d.pop("nextCursor"))

        developer_room_catalog_page = cls(
            counts=counts,
            items=items,
            next_cursor=next_cursor,
        )

        return developer_room_catalog_page
