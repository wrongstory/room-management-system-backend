from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_database_status_photo_purge_status import (
    DeveloperDatabaseStatusPhotoPurgeStatus,
)

if TYPE_CHECKING:
    from ..models.developer_database_status_photo_purge_backlog import (
        DeveloperDatabaseStatusPhotoPurgeBacklog,
    )
    from ..models.developer_database_status_photo_purge_last_heartbeat_type_0 import (
        DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0,
    )


T = TypeVar("T", bound="DeveloperDatabaseStatusPhotoPurge")


@_attrs_define
class DeveloperDatabaseStatusPhotoPurge:
    """
    Attributes:
        status (DeveloperDatabaseStatusPhotoPurgeStatus):
        last_heartbeat (DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0 | None):
        backlog (DeveloperDatabaseStatusPhotoPurgeBacklog):
        checked_at (datetime.datetime):
    """

    status: DeveloperDatabaseStatusPhotoPurgeStatus
    last_heartbeat: DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0 | None
    backlog: DeveloperDatabaseStatusPhotoPurgeBacklog
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        from ..models.developer_database_status_photo_purge_last_heartbeat_type_0 import (
            DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0,
        )

        status = self.status.value

        last_heartbeat: dict[str, Any] | None
        if isinstance(self.last_heartbeat, DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0):
            last_heartbeat = self.last_heartbeat.to_dict()
        else:
            last_heartbeat = self.last_heartbeat

        backlog = self.backlog.to_dict()

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "lastHeartbeat": last_heartbeat,
                "backlog": backlog,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_database_status_photo_purge_backlog import (
            DeveloperDatabaseStatusPhotoPurgeBacklog,
        )
        from ..models.developer_database_status_photo_purge_last_heartbeat_type_0 import (
            DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0,
        )

        d = dict(src_dict)
        status = DeveloperDatabaseStatusPhotoPurgeStatus(d.pop("status"))

        def _parse_last_heartbeat(
            data: object,
        ) -> DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                last_heartbeat_type_0 = (
                    DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0.from_dict(data)
                )

                return last_heartbeat_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0 | None, data)

        last_heartbeat = _parse_last_heartbeat(d.pop("lastHeartbeat"))

        backlog = DeveloperDatabaseStatusPhotoPurgeBacklog.from_dict(d.pop("backlog"))

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        developer_database_status_photo_purge = cls(
            status=status,
            last_heartbeat=last_heartbeat,
            backlog=backlog,
            checked_at=checked_at,
        )

        return developer_database_status_photo_purge
