from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_scheduler_status_last_heartbeat_type_0_status import (
    DeveloperSchedulerStatusLastHeartbeatType0Status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperSchedulerStatusLastHeartbeatType0")


@_attrs_define
class DeveloperSchedulerStatusLastHeartbeatType0:
    """
    Attributes:
        invocation_key (str | Unset):
        scheduled_at (datetime.datetime | Unset):
        status (DeveloperSchedulerStatusLastHeartbeatType0Status | Unset):
        transition_count (int | None | Unset):
        error_code (None | str | Unset):
        attempt_count (int | Unset):
        completed_at (datetime.datetime | Unset):
    """

    invocation_key: str | Unset = UNSET
    scheduled_at: datetime.datetime | Unset = UNSET
    status: DeveloperSchedulerStatusLastHeartbeatType0Status | Unset = UNSET
    transition_count: int | None | Unset = UNSET
    error_code: None | str | Unset = UNSET
    attempt_count: int | Unset = UNSET
    completed_at: datetime.datetime | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        invocation_key = self.invocation_key

        scheduled_at: str | Unset = UNSET
        if not isinstance(self.scheduled_at, Unset):
            scheduled_at = self.scheduled_at.isoformat()

        status: str | Unset = UNSET
        if not isinstance(self.status, Unset):
            status = self.status.value

        transition_count: int | None | Unset
        if isinstance(self.transition_count, Unset):
            transition_count = UNSET
        else:
            transition_count = self.transition_count

        error_code: None | str | Unset
        if isinstance(self.error_code, Unset):
            error_code = UNSET
        else:
            error_code = self.error_code

        attempt_count = self.attempt_count

        completed_at: str | Unset = UNSET
        if not isinstance(self.completed_at, Unset):
            completed_at = self.completed_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if invocation_key is not UNSET:
            field_dict["invocationKey"] = invocation_key
        if scheduled_at is not UNSET:
            field_dict["scheduledAt"] = scheduled_at
        if status is not UNSET:
            field_dict["status"] = status
        if transition_count is not UNSET:
            field_dict["transitionCount"] = transition_count
        if error_code is not UNSET:
            field_dict["errorCode"] = error_code
        if attempt_count is not UNSET:
            field_dict["attemptCount"] = attempt_count
        if completed_at is not UNSET:
            field_dict["completedAt"] = completed_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        invocation_key = d.pop("invocationKey", UNSET)

        _scheduled_at = d.pop("scheduledAt", UNSET)
        scheduled_at: datetime.datetime | Unset
        if isinstance(_scheduled_at, Unset):
            scheduled_at = UNSET
        else:
            scheduled_at = datetime.datetime.fromisoformat(_scheduled_at)

        _status = d.pop("status", UNSET)
        status: DeveloperSchedulerStatusLastHeartbeatType0Status | Unset
        if isinstance(_status, Unset):
            status = UNSET
        else:
            status = DeveloperSchedulerStatusLastHeartbeatType0Status(_status)

        def _parse_transition_count(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        transition_count = _parse_transition_count(d.pop("transitionCount", UNSET))

        def _parse_error_code(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        error_code = _parse_error_code(d.pop("errorCode", UNSET))

        attempt_count = d.pop("attemptCount", UNSET)

        _completed_at = d.pop("completedAt", UNSET)
        completed_at: datetime.datetime | Unset
        if isinstance(_completed_at, Unset):
            completed_at = UNSET
        else:
            completed_at = datetime.datetime.fromisoformat(_completed_at)

        developer_scheduler_status_last_heartbeat_type_0 = cls(
            invocation_key=invocation_key,
            scheduled_at=scheduled_at,
            status=status,
            transition_count=transition_count,
            error_code=error_code,
            attempt_count=attempt_count,
            completed_at=completed_at,
        )

        return developer_scheduler_status_last_heartbeat_type_0
