from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperActivityEventSummary")


@_attrs_define
class DeveloperActivityEventSummary:
    """unknown login aggregate에만 count/lastOccurredAt/bucketMinutes를 반환합니다.

    Attributes:
        aggregate_count (int | Unset):
        last_occurred_at (datetime.datetime | Unset):
        bucket_minutes (Literal[1] | Unset):
    """

    aggregate_count: int | Unset = UNSET
    last_occurred_at: datetime.datetime | Unset = UNSET
    bucket_minutes: Literal[1] | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        aggregate_count = self.aggregate_count

        last_occurred_at: str | Unset = UNSET
        if not isinstance(self.last_occurred_at, Unset):
            last_occurred_at = self.last_occurred_at.isoformat()

        bucket_minutes = self.bucket_minutes

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if aggregate_count is not UNSET:
            field_dict["aggregateCount"] = aggregate_count
        if last_occurred_at is not UNSET:
            field_dict["lastOccurredAt"] = last_occurred_at
        if bucket_minutes is not UNSET:
            field_dict["bucketMinutes"] = bucket_minutes

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        aggregate_count = d.pop("aggregateCount", UNSET)

        _last_occurred_at = d.pop("lastOccurredAt", UNSET)
        last_occurred_at: datetime.datetime | Unset
        if isinstance(_last_occurred_at, Unset):
            last_occurred_at = UNSET
        else:
            last_occurred_at = datetime.datetime.fromisoformat(_last_occurred_at)

        bucket_minutes = cast(Literal[1] | Unset, d.pop("bucketMinutes", UNSET))
        if bucket_minutes != 1 and not isinstance(bucket_minutes, Unset):
            raise ValueError(f"bucketMinutes must match const 1, got '{bucket_minutes}'")

        developer_activity_event_summary = cls(
            aggregate_count=aggregate_count,
            last_occurred_at=last_occurred_at,
            bucket_minutes=bucket_minutes,
        )

        return developer_activity_event_summary
