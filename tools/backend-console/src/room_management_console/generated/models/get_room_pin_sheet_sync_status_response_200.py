from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.room_pin_sheet_operator_status import RoomPinSheetOperatorStatus


T = TypeVar("T", bound="GetRoomPinSheetSyncStatusResponse200")


@_attrs_define
class GetRoomPinSheetSyncStatusResponse200:
    """
    Attributes:
        sync (RoomPinSheetOperatorStatus):
    """

    sync: RoomPinSheetOperatorStatus

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
        from ..models.room_pin_sheet_operator_status import RoomPinSheetOperatorStatus

        d = dict(src_dict)
        sync = RoomPinSheetOperatorStatus.from_dict(d.pop("sync"))

        get_room_pin_sheet_sync_status_response_200 = cls(
            sync=sync,
        )

        return get_room_pin_sheet_sync_status_response_200
