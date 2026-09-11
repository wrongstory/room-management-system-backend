from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperDatabaseStatusNotificationDeliveryBacklog")


@_attrs_define
class DeveloperDatabaseStatusNotificationDeliveryBacklog:
    """
    Attributes:
        due (int):
        retrying (int):
        dead_letter (int):
        blocked (int):
        expired_leases (int):
        oldest_due_at (datetime.datetime | None):
    """

    due: int
    retrying: int
    dead_letter: int
    blocked: int
    expired_leases: int
    oldest_due_at: datetime.datetime | None

    def to_dict(self) -> dict[str, Any]:
        due = self.due

        retrying = self.retrying

        dead_letter = self.dead_letter

        blocked = self.blocked

        expired_leases = self.expired_leases

        oldest_due_at: None | str
        if isinstance(self.oldest_due_at, datetime.datetime):
            oldest_due_at = self.oldest_due_at.isoformat()
        else:
            oldest_due_at = self.oldest_due_at

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "due": due,
                "retrying": retrying,
                "deadLetter": dead_letter,
                "blocked": blocked,
                "expiredLeases": expired_leases,
                "oldestDueAt": oldest_due_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        due = d.pop("due")

        retrying = d.pop("retrying")

        dead_letter = d.pop("deadLetter")

        blocked = d.pop("blocked")

        expired_leases = d.pop("expiredLeases")

        def _parse_oldest_due_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                oldest_due_at_type_0 = datetime.datetime.fromisoformat(data)

                return oldest_due_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        oldest_due_at = _parse_oldest_due_at(d.pop("oldestDueAt"))

        developer_database_status_notification_delivery_backlog = cls(
            due=due,
            retrying=retrying,
            dead_letter=dead_letter,
            blocked=blocked,
            expired_leases=expired_leases,
            oldest_due_at=oldest_due_at,
        )

        return developer_database_status_notification_delivery_backlog
