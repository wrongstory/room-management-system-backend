from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="RoomPinSheetSyncStatusWorker")


@_attrs_define
class RoomPinSheetSyncStatusWorker:
    """
    Attributes:
        operator_blocked (bool):
        blocked_reason_code (None | str):
    """

    operator_blocked: bool
    blocked_reason_code: None | str

    def to_dict(self) -> dict[str, Any]:
        operator_blocked = self.operator_blocked

        blocked_reason_code: None | str
        blocked_reason_code = self.blocked_reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "operatorBlocked": operator_blocked,
                "blockedReasonCode": blocked_reason_code,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        operator_blocked = d.pop("operatorBlocked")

        def _parse_blocked_reason_code(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        blocked_reason_code = _parse_blocked_reason_code(d.pop("blockedReasonCode"))

        room_pin_sheet_sync_status_worker = cls(
            operator_blocked=operator_blocked,
            blocked_reason_code=blocked_reason_code,
        )

        return room_pin_sheet_sync_status_worker
