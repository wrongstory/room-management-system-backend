from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.room_pin_sheet_sync_status_status import RoomPinSheetSyncStatusStatus

if TYPE_CHECKING:
    from ..models.room_pin_sheet_sync_status_activation import RoomPinSheetSyncStatusActivation
    from ..models.room_pin_sheet_sync_status_backlog import RoomPinSheetSyncStatusBacklog
    from ..models.room_pin_sheet_sync_status_last_heartbeat_type_0 import (
        RoomPinSheetSyncStatusLastHeartbeatType0,
    )
    from ..models.room_pin_sheet_sync_status_worker import RoomPinSheetSyncStatusWorker


T = TypeVar("T", bound="RoomPinSheetSyncStatus")


@_attrs_define
class RoomPinSheetSyncStatus:
    """
    Attributes:
        status (RoomPinSheetSyncStatusStatus):
        last_heartbeat (None | RoomPinSheetSyncStatusLastHeartbeatType0):
        backlog (RoomPinSheetSyncStatusBacklog):
        worker (RoomPinSheetSyncStatusWorker):
        activation (RoomPinSheetSyncStatusActivation):
        checked_at (datetime.datetime):
    """

    status: RoomPinSheetSyncStatusStatus
    last_heartbeat: None | RoomPinSheetSyncStatusLastHeartbeatType0
    backlog: RoomPinSheetSyncStatusBacklog
    worker: RoomPinSheetSyncStatusWorker
    activation: RoomPinSheetSyncStatusActivation
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        from ..models.room_pin_sheet_sync_status_last_heartbeat_type_0 import (
            RoomPinSheetSyncStatusLastHeartbeatType0,
        )

        status = self.status.value

        last_heartbeat: dict[str, Any] | None
        if isinstance(self.last_heartbeat, RoomPinSheetSyncStatusLastHeartbeatType0):
            last_heartbeat = self.last_heartbeat.to_dict()
        else:
            last_heartbeat = self.last_heartbeat

        backlog = self.backlog.to_dict()

        worker = self.worker.to_dict()

        activation = self.activation.to_dict()

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "lastHeartbeat": last_heartbeat,
                "backlog": backlog,
                "worker": worker,
                "activation": activation,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.room_pin_sheet_sync_status_activation import RoomPinSheetSyncStatusActivation
        from ..models.room_pin_sheet_sync_status_backlog import RoomPinSheetSyncStatusBacklog
        from ..models.room_pin_sheet_sync_status_last_heartbeat_type_0 import (
            RoomPinSheetSyncStatusLastHeartbeatType0,
        )
        from ..models.room_pin_sheet_sync_status_worker import RoomPinSheetSyncStatusWorker

        d = dict(src_dict)
        status = RoomPinSheetSyncStatusStatus(d.pop("status"))

        def _parse_last_heartbeat(data: object) -> None | RoomPinSheetSyncStatusLastHeartbeatType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                last_heartbeat_type_0 = RoomPinSheetSyncStatusLastHeartbeatType0.from_dict(data)

                return last_heartbeat_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | RoomPinSheetSyncStatusLastHeartbeatType0, data)

        last_heartbeat = _parse_last_heartbeat(d.pop("lastHeartbeat"))

        backlog = RoomPinSheetSyncStatusBacklog.from_dict(d.pop("backlog"))

        worker = RoomPinSheetSyncStatusWorker.from_dict(d.pop("worker"))

        activation = RoomPinSheetSyncStatusActivation.from_dict(d.pop("activation"))

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        room_pin_sheet_sync_status = cls(
            status=status,
            last_heartbeat=last_heartbeat,
            backlog=backlog,
            worker=worker,
            activation=activation,
            checked_at=checked_at,
        )

        return room_pin_sheet_sync_status
