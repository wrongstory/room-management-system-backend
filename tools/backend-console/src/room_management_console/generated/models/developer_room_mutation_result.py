from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem
    from ..models.developer_room_catalog_summary import DeveloperRoomCatalogSummary
    from ..models.developer_room_type_catalog_item import DeveloperRoomTypeCatalogItem


T = TypeVar("T", bound="DeveloperRoomMutationResult")


@_attrs_define
class DeveloperRoomMutationResult:
    """
    Attributes:
        room (DeveloperRoomCatalogItem):
        summary (DeveloperRoomCatalogSummary):
        effective_at (datetime.datetime):
        room_type (DeveloperRoomTypeCatalogItem | Unset):
    """

    room: DeveloperRoomCatalogItem
    summary: DeveloperRoomCatalogSummary
    effective_at: datetime.datetime
    room_type: DeveloperRoomTypeCatalogItem | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        room = self.room.to_dict()

        summary = self.summary.to_dict()

        effective_at = self.effective_at.isoformat()

        room_type: dict[str, Any] | Unset = UNSET
        if not isinstance(self.room_type, Unset):
            room_type = self.room_type.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "room": room,
                "summary": summary,
                "effectiveAt": effective_at,
            }
        )
        if room_type is not UNSET:
            field_dict["roomType"] = room_type

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_catalog_item import DeveloperRoomCatalogItem
        from ..models.developer_room_catalog_summary import DeveloperRoomCatalogSummary
        from ..models.developer_room_type_catalog_item import DeveloperRoomTypeCatalogItem

        d = dict(src_dict)
        room = DeveloperRoomCatalogItem.from_dict(d.pop("room"))

        summary = DeveloperRoomCatalogSummary.from_dict(d.pop("summary"))

        effective_at = datetime.datetime.fromisoformat(d.pop("effectiveAt"))

        _room_type = d.pop("roomType", UNSET)
        room_type: DeveloperRoomTypeCatalogItem | Unset
        if isinstance(_room_type, Unset):
            room_type = UNSET
        else:
            room_type = DeveloperRoomTypeCatalogItem.from_dict(_room_type)

        developer_room_mutation_result = cls(
            room=room,
            summary=summary,
            effective_at=effective_at,
            room_type=room_type,
        )

        return developer_room_mutation_result
