from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.room_pin_sheet_full_resync_accepted import RoomPinSheetFullResyncAccepted


T = TypeVar("T", bound="RequestRoomPinSheetFullResyncResponse202")


@_attrs_define
class RequestRoomPinSheetFullResyncResponse202:
    """
    Attributes:
        sync (RoomPinSheetFullResyncAccepted):
    """

    sync: RoomPinSheetFullResyncAccepted

    def to_dict(self) -> dict[str, Any]:
        sync = self.sync.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "sync": sync,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.room_pin_sheet_full_resync_accepted import RoomPinSheetFullResyncAccepted

        d = dict(src_dict)
        sync = RoomPinSheetFullResyncAccepted.from_dict(d.pop("sync"))

        request_room_pin_sheet_full_resync_response_202 = cls(
            sync=sync,
        )

        return request_room_pin_sheet_full_resync_response_202
