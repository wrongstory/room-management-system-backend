from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="RoomPinSheetFullResyncAccepted")


@_attrs_define
class RoomPinSheetFullResyncAccepted:
    """
    Attributes:
        status (Literal['pending']):
        room_count (Literal[121]):
        version (int):
    """

    status: Literal["pending"]
    room_count: Literal[121]
    version: int

    def to_dict(self) -> dict[str, Any]:
        status = self.status

        room_count = self.room_count

        version = self.version

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "roomCount": room_count,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = cast(Literal["pending"], d.pop("status"))
        if status != "pending":
            raise ValueError(f"status must match const 'pending', got '{status}'")

        room_count = cast(Literal[121], d.pop("roomCount"))
        if room_count != 121:
            raise ValueError(f"roomCount must match const 121, got '{room_count}'")

        version = d.pop("version")

        room_pin_sheet_full_resync_accepted = cls(
            status=status,
            room_count=room_count,
            version=version,
        )

        return room_pin_sheet_full_resync_accepted
