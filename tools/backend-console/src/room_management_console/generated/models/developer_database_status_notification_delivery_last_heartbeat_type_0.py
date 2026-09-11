from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_database_status_notification_delivery_last_heartbeat_type_0_status import (
    DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0Status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0")


@_attrs_define
class DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0:
    """
    Attributes:
        status (DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0Status | Unset):
        claimed (int | Unset):
        delivered (int | Unset):
        retrying (int | Unset):
        suppressed (int | Unset):
        dead_letter (int | Unset):
        blocked (int | Unset):
        deferred (int | Unset):
        error_code (None | str | Unset):
        recorded_at (datetime.datetime | Unset):
    """

    status: DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0Status | Unset = UNSET
    claimed: int | Unset = UNSET
    delivered: int | Unset = UNSET
    retrying: int | Unset = UNSET
    suppressed: int | Unset = UNSET
    dead_letter: int | Unset = UNSET
    blocked: int | Unset = UNSET
    deferred: int | Unset = UNSET
    error_code: None | str | Unset = UNSET
    recorded_at: datetime.datetime | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        status: str | Unset = UNSET
        if not isinstance(self.status, Unset):
            status = self.status.value

        claimed = self.claimed

        delivered = self.delivered

        retrying = self.retrying

        suppressed = self.suppressed

        dead_letter = self.dead_letter

        blocked = self.blocked

        deferred = self.deferred

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
        if delivered is not UNSET:
            field_dict["delivered"] = delivered
        if retrying is not UNSET:
            field_dict["retrying"] = retrying
        if suppressed is not UNSET:
            field_dict["suppressed"] = suppressed
        if dead_letter is not UNSET:
            field_dict["deadLetter"] = dead_letter
        if blocked is not UNSET:
            field_dict["blocked"] = blocked
        if deferred is not UNSET:
            field_dict["deferred"] = deferred
        if error_code is not UNSET:
            field_dict["errorCode"] = error_code
        if recorded_at is not UNSET:
            field_dict["recordedAt"] = recorded_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _status = d.pop("status", UNSET)
        status: DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0Status | Unset
        if isinstance(_status, Unset):
            status = UNSET
        else:
            status = DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0Status(_status)

        claimed = d.pop("claimed", UNSET)

        delivered = d.pop("delivered", UNSET)

        retrying = d.pop("retrying", UNSET)

        suppressed = d.pop("suppressed", UNSET)

        dead_letter = d.pop("deadLetter", UNSET)

        blocked = d.pop("blocked", UNSET)

        deferred = d.pop("deferred", UNSET)

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

        developer_database_status_notification_delivery_last_heartbeat_type_0 = cls(
            status=status,
            claimed=claimed,
            delivered=delivered,
            retrying=retrying,
            suppressed=suppressed,
            dead_letter=dead_letter,
            blocked=blocked,
            deferred=deferred,
            error_code=error_code,
            recorded_at=recorded_at,
        )

        return developer_database_status_notification_delivery_last_heartbeat_type_0
