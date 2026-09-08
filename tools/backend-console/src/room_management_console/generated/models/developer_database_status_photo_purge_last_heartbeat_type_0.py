from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_database_status_photo_purge_last_heartbeat_type_0_status import (
    DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0Status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0")


@_attrs_define
class DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0:
    """
    Attributes:
        status (DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0Status | Unset):
        claimed (int | Unset):
        purged (int | Unset):
        retrying (int | Unset):
        blocked (int | Unset):
        accepted_claimed (int | Unset):
        orphan_claimed (int | Unset):
        folder_claimed (int | Unset):
        error_code (None | str | Unset):
        recorded_at (datetime.datetime | Unset):
    """

    status: DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0Status | Unset = UNSET
    claimed: int | Unset = UNSET
    purged: int | Unset = UNSET
    retrying: int | Unset = UNSET
    blocked: int | Unset = UNSET
    accepted_claimed: int | Unset = UNSET
    orphan_claimed: int | Unset = UNSET
    folder_claimed: int | Unset = UNSET
    error_code: None | str | Unset = UNSET
    recorded_at: datetime.datetime | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        status: str | Unset = UNSET
        if not isinstance(self.status, Unset):
            status = self.status.value

        claimed = self.claimed

        purged = self.purged

        retrying = self.retrying

        blocked = self.blocked

        accepted_claimed = self.accepted_claimed

        orphan_claimed = self.orphan_claimed

        folder_claimed = self.folder_claimed

        error_code: None | str | Unset
        if isinstance(self.error_code, Unset):
            error_code = UNSET
        else:
            error_code = self.error_code

        recorded_at: str | Unset = UNSET
        if not isinstance(self.recorded_at, Unset):
            recorded_at = self.recorded_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if status is not UNSET:
            field_dict["status"] = status
        if claimed is not UNSET:
            field_dict["claimed"] = claimed
        if purged is not UNSET:
            field_dict["purged"] = purged
        if retrying is not UNSET:
            field_dict["retrying"] = retrying
        if blocked is not UNSET:
            field_dict["blocked"] = blocked
        if accepted_claimed is not UNSET:
            field_dict["acceptedClaimed"] = accepted_claimed
        if orphan_claimed is not UNSET:
            field_dict["orphanClaimed"] = orphan_claimed
        if folder_claimed is not UNSET:
            field_dict["folderClaimed"] = folder_claimed
        if error_code is not UNSET:
            field_dict["errorCode"] = error_code
        if recorded_at is not UNSET:
            field_dict["recordedAt"] = recorded_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _status = d.pop("status", UNSET)
        status: DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0Status | Unset
        if isinstance(_status, Unset):
            status = UNSET
        else:
            status = DeveloperDatabaseStatusPhotoPurgeLastHeartbeatType0Status(_status)

        claimed = d.pop("claimed", UNSET)

        purged = d.pop("purged", UNSET)

        retrying = d.pop("retrying", UNSET)

        blocked = d.pop("blocked", UNSET)

        accepted_claimed = d.pop("acceptedClaimed", UNSET)

        orphan_claimed = d.pop("orphanClaimed", UNSET)

        folder_claimed = d.pop("folderClaimed", UNSET)

        def _parse_error_code(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        error_code = _parse_error_code(d.pop("errorCode", UNSET))

        _recorded_at = d.pop("recordedAt", UNSET)
        recorded_at: datetime.datetime | Unset
        if isinstance(_recorded_at, Unset):
            recorded_at = UNSET
        else:
            recorded_at = datetime.datetime.fromisoformat(_recorded_at)

        developer_database_status_photo_purge_last_heartbeat_type_0 = cls(
            status=status,
            claimed=claimed,
            purged=purged,
            retrying=retrying,
            blocked=blocked,
            accepted_claimed=accepted_claimed,
            orphan_claimed=orphan_claimed,
            folder_claimed=folder_claimed,
            error_code=error_code,
            recorded_at=recorded_at,
        )

        return developer_database_status_photo_purge_last_heartbeat_type_0
