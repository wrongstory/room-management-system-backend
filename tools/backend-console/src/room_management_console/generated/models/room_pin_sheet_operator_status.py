from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="RoomPinSheetOperatorStatus")


@_attrs_define
class RoomPinSheetOperatorStatus:
    """
    Attributes:
        pending (int):
        failed (int):
        operator_blocked (bool):
        oldest_pending_at (datetime.datetime | None):
        last_success_at (datetime.datetime | None):
        last_error_code (None | str):
        version (int): full-resync command용 singleton fence CAS version
        checked_at (datetime.datetime):
    """

    pending: int
    failed: int
    operator_blocked: bool
    oldest_pending_at: datetime.datetime | None
    last_success_at: datetime.datetime | None
    last_error_code: None | str
    version: int
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        pending = self.pending

        failed = self.failed

        operator_blocked = self.operator_blocked

        oldest_pending_at: None | str
        if isinstance(self.oldest_pending_at, datetime.datetime):
            oldest_pending_at = self.oldest_pending_at.isoformat()
        else:
            oldest_pending_at = self.oldest_pending_at

        last_success_at: None | str
        if isinstance(self.last_success_at, datetime.datetime):
            last_success_at = self.last_success_at.isoformat()
        else:
            last_success_at = self.last_success_at

        last_error_code: None | str
        last_error_code = self.last_error_code

        version = self.version

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "pending": pending,
                "failed": failed,
                "operatorBlocked": operator_blocked,
                "oldestPendingAt": oldest_pending_at,
                "lastSuccessAt": last_success_at,
                "lastErrorCode": last_error_code,
                "version": version,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        pending = d.pop("pending")

        failed = d.pop("failed")

        operator_blocked = d.pop("operatorBlocked")

        def _parse_oldest_pending_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                oldest_pending_at_type_0 = datetime.datetime.fromisoformat(data)

                return oldest_pending_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        oldest_pending_at = _parse_oldest_pending_at(d.pop("oldestPendingAt"))

        def _parse_last_success_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                last_success_at_type_0 = datetime.datetime.fromisoformat(data)

                return last_success_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        last_success_at = _parse_last_success_at(d.pop("lastSuccessAt"))

        def _parse_last_error_code(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        last_error_code = _parse_last_error_code(d.pop("lastErrorCode"))

        version = d.pop("version")

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        room_pin_sheet_operator_status = cls(
            pending=pending,
            failed=failed,
            operator_blocked=operator_blocked,
            oldest_pending_at=oldest_pending_at,
            last_success_at=last_success_at,
            last_error_code=last_error_code,
            version=version,
            checked_at=checked_at,
        )

        return room_pin_sheet_operator_status
