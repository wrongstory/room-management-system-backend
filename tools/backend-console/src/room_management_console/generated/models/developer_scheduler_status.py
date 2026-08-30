from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_scheduler_status_status import DeveloperSchedulerStatusStatus

if TYPE_CHECKING:
    from ..models.developer_scheduler_status_last_cron_run_type_0 import (
        DeveloperSchedulerStatusLastCronRunType0,
    )
    from ..models.developer_scheduler_status_last_heartbeat_type_0 import (
        DeveloperSchedulerStatusLastHeartbeatType0,
    )


T = TypeVar("T", bound="DeveloperSchedulerStatus")


@_attrs_define
class DeveloperSchedulerStatus:
    """
    Attributes:
        status (DeveloperSchedulerStatusStatus):
        cron_catalog_available (bool):
        cron_configured (bool):
        cron_active (bool):
        cadence (None | str):
        scheduler_actor_configured (bool):
        scheduler_actor_valid (bool):
        invoke_secret_configured (bool):
        last_cron_run (DeveloperSchedulerStatusLastCronRunType0 | None):
        last_heartbeat (DeveloperSchedulerStatusLastHeartbeatType0 | None):
        checked_at (datetime.datetime):
    """

    status: DeveloperSchedulerStatusStatus
    cron_catalog_available: bool
    cron_configured: bool
    cron_active: bool
    cadence: None | str
    scheduler_actor_configured: bool
    scheduler_actor_valid: bool
    invoke_secret_configured: bool
    last_cron_run: DeveloperSchedulerStatusLastCronRunType0 | None
    last_heartbeat: DeveloperSchedulerStatusLastHeartbeatType0 | None
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        from ..models.developer_scheduler_status_last_cron_run_type_0 import (
            DeveloperSchedulerStatusLastCronRunType0,
        )
        from ..models.developer_scheduler_status_last_heartbeat_type_0 import (
            DeveloperSchedulerStatusLastHeartbeatType0,
        )

        status = self.status.value

        cron_catalog_available = self.cron_catalog_available

        cron_configured = self.cron_configured

        cron_active = self.cron_active

        cadence: None | str
        cadence = self.cadence

        scheduler_actor_configured = self.scheduler_actor_configured

        scheduler_actor_valid = self.scheduler_actor_valid

        invoke_secret_configured = self.invoke_secret_configured

        last_cron_run: dict[str, Any] | None
        if isinstance(self.last_cron_run, DeveloperSchedulerStatusLastCronRunType0):
            last_cron_run = self.last_cron_run.to_dict()
        else:
            last_cron_run = self.last_cron_run

        last_heartbeat: dict[str, Any] | None
        if isinstance(self.last_heartbeat, DeveloperSchedulerStatusLastHeartbeatType0):
            last_heartbeat = self.last_heartbeat.to_dict()
        else:
            last_heartbeat = self.last_heartbeat

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "cronCatalogAvailable": cron_catalog_available,
                "cronConfigured": cron_configured,
                "cronActive": cron_active,
                "cadence": cadence,
                "schedulerActorConfigured": scheduler_actor_configured,
                "schedulerActorValid": scheduler_actor_valid,
                "invokeSecretConfigured": invoke_secret_configured,
                "lastCronRun": last_cron_run,
                "lastHeartbeat": last_heartbeat,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_scheduler_status_last_cron_run_type_0 import (
            DeveloperSchedulerStatusLastCronRunType0,
        )
        from ..models.developer_scheduler_status_last_heartbeat_type_0 import (
            DeveloperSchedulerStatusLastHeartbeatType0,
        )

        d = dict(src_dict)
        status = DeveloperSchedulerStatusStatus(d.pop("status"))

        cron_catalog_available = d.pop("cronCatalogAvailable")

        cron_configured = d.pop("cronConfigured")

        cron_active = d.pop("cronActive")

        def _parse_cadence(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        cadence = _parse_cadence(d.pop("cadence"))

        scheduler_actor_configured = d.pop("schedulerActorConfigured")

        scheduler_actor_valid = d.pop("schedulerActorValid")

        invoke_secret_configured = d.pop("invokeSecretConfigured")

        def _parse_last_cron_run(data: object) -> DeveloperSchedulerStatusLastCronRunType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                last_cron_run_type_0 = DeveloperSchedulerStatusLastCronRunType0.from_dict(data)

                return last_cron_run_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(DeveloperSchedulerStatusLastCronRunType0 | None, data)

        last_cron_run = _parse_last_cron_run(d.pop("lastCronRun"))

        def _parse_last_heartbeat(
            data: object,
        ) -> DeveloperSchedulerStatusLastHeartbeatType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                last_heartbeat_type_0 = DeveloperSchedulerStatusLastHeartbeatType0.from_dict(data)

                return last_heartbeat_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(DeveloperSchedulerStatusLastHeartbeatType0 | None, data)

        last_heartbeat = _parse_last_heartbeat(d.pop("lastHeartbeat"))

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        developer_scheduler_status = cls(
            status=status,
            cron_catalog_available=cron_catalog_available,
            cron_configured=cron_configured,
            cron_active=cron_active,
            cadence=cadence,
            scheduler_actor_configured=scheduler_actor_configured,
            scheduler_actor_valid=scheduler_actor_valid,
            invoke_secret_configured=invoke_secret_configured,
            last_cron_run=last_cron_run,
            last_heartbeat=last_heartbeat,
            checked_at=checked_at,
        )

        return developer_scheduler_status
