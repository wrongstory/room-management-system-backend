from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperDatabaseStatusRowCounts")


@_attrs_define
class DeveloperDatabaseStatusRowCounts:
    """
    Attributes:
        profiles (int):
        rooms (int):
        audit_events_estimate (int): append-only 감사 원장의 catalog 추정치. dashboard를 위해 전체 count scan을 하지 않습니다.
    """

    profiles: int
    rooms: int
    audit_events_estimate: int

    def to_dict(self) -> dict[str, Any]:
        profiles = self.profiles

        rooms = self.rooms

        audit_events_estimate = self.audit_events_estimate

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "profiles": profiles,
                "rooms": rooms,
                "auditEventsEstimate": audit_events_estimate,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        profiles = d.pop("profiles")

        rooms = d.pop("rooms")

        audit_events_estimate = d.pop("auditEventsEstimate")

        developer_database_status_row_counts = cls(
            profiles=profiles,
            rooms=rooms,
            audit_events_estimate=audit_events_estimate,
        )

        return developer_database_status_row_counts
