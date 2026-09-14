from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.room_pin_sheet_sync_status_last_heartbeat_type_0_status import (
    RoomPinSheetSyncStatusLastHeartbeatType0Status,
)

T = TypeVar("T", bound="RoomPinSheetSyncStatusLastHeartbeatType0")


@_attrs_define
class RoomPinSheetSyncStatusLastHeartbeatType0:
    """
    Attributes:
        status (RoomPinSheetSyncStatusLastHeartbeatType0Status):
        claimed (int):
        projected (int):
        already_current (int):
        superseded (int):
        retrying (int):
        blocked (int):
        error_code (None | str):
        recorded_at (datetime.datetime):
    """

    status: RoomPinSheetSyncStatusLastHeartbeatType0Status
    claimed: int
    projected: int
    already_current: int
    superseded: int
    retrying: int
    blocked: int
    error_code: None | str
    recorded_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        status = self.status.value

        claimed = self.claimed

        projected = self.projected

        already_current = self.already_current

        superseded = self.superseded

        retrying = self.retrying

        blocked = self.blocked

        error_code: None | str
        error_code = self.error_code

        recorded_at = self.recorded_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "claimed": claimed,
                "projected": projected,
                "alreadyCurrent": already_current,
                "superseded": superseded,
                "retrying": retrying,
                "blocked": blocked,
                "errorCode": error_code,
                "recordedAt": recorded_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = RoomPinSheetSyncStatusLastHeartbeatType0Status(d.pop("status"))

        claimed = d.pop("claimed")

        projected = d.pop("projected")

        already_current = d.pop("alreadyCurrent")

        superseded = d.pop("superseded")

        retrying = d.pop("retrying")

        blocked = d.pop("blocked")

        def _parse_error_code(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        error_code = _parse_error_code(d.pop("errorCode"))

        recorded_at = datetime.datetime.fromisoformat(d.pop("recordedAt"))

        room_pin_sheet_sync_status_last_heartbeat_type_0 = cls(
            status=status,
            claimed=claimed,
            projected=projected,
            already_current=already_current,
            superseded=superseded,
            retrying=retrying,
            blocked=blocked,
            error_code=error_code,
            recorded_at=recorded_at,
        )

        return room_pin_sheet_sync_status_last_heartbeat_type_0
