from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_database_status import DeveloperDatabaseStatus
    from ..models.developer_overview_accounts import DeveloperOverviewAccounts
    from ..models.developer_overview_rooms import DeveloperOverviewRooms
    from ..models.developer_runtime_status import DeveloperRuntimeStatus
    from ..models.developer_scheduler_status import DeveloperSchedulerStatus


T = TypeVar("T", bound="DeveloperOverview")


@_attrs_define
class DeveloperOverview:
    """
    Attributes:
        generated_at (datetime.datetime):
        accounts (DeveloperOverviewAccounts):
        rooms (DeveloperOverviewRooms):
        audit_events_last_24_hours (int):
        runtime (DeveloperRuntimeStatus):
        database (DeveloperDatabaseStatus):
        scheduler (DeveloperSchedulerStatus):
    """

    generated_at: datetime.datetime
    accounts: DeveloperOverviewAccounts
    rooms: DeveloperOverviewRooms
    audit_events_last_24_hours: int
    runtime: DeveloperRuntimeStatus
    database: DeveloperDatabaseStatus
    scheduler: DeveloperSchedulerStatus

    def to_dict(self) -> dict[str, Any]:
        generated_at = self.generated_at.isoformat()

        accounts = self.accounts.to_dict()

        rooms = self.rooms.to_dict()

        audit_events_last_24_hours = self.audit_events_last_24_hours

        runtime = self.runtime.to_dict()

        database = self.database.to_dict()

        scheduler = self.scheduler.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "generatedAt": generated_at,
                "accounts": accounts,
                "rooms": rooms,
                "auditEventsLast24Hours": audit_events_last_24_hours,
                "runtime": runtime,
                "database": database,
                "scheduler": scheduler,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_database_status import DeveloperDatabaseStatus
        from ..models.developer_overview_accounts import DeveloperOverviewAccounts
        from ..models.developer_overview_rooms import DeveloperOverviewRooms
        from ..models.developer_runtime_status import DeveloperRuntimeStatus
        from ..models.developer_scheduler_status import DeveloperSchedulerStatus

        d = dict(src_dict)
        generated_at = datetime.datetime.fromisoformat(d.pop("generatedAt"))

        accounts = DeveloperOverviewAccounts.from_dict(d.pop("accounts"))

        rooms = DeveloperOverviewRooms.from_dict(d.pop("rooms"))

        audit_events_last_24_hours = d.pop("auditEventsLast24Hours")

        runtime = DeveloperRuntimeStatus.from_dict(d.pop("runtime"))

        database = DeveloperDatabaseStatus.from_dict(d.pop("database"))

        scheduler = DeveloperSchedulerStatus.from_dict(d.pop("scheduler"))

        developer_overview = cls(
            generated_at=generated_at,
            accounts=accounts,
            rooms=rooms,
            audit_events_last_24_hours=audit_events_last_24_hours,
            runtime=runtime,
            database=database,
            scheduler=scheduler,
        )

        return developer_overview
