from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_database_status_notification_delivery_status import (
    DeveloperDatabaseStatusNotificationDeliveryStatus,
)

if TYPE_CHECKING:
    from ..models.developer_database_status_notification_delivery_activation import (
        DeveloperDatabaseStatusNotificationDeliveryActivation,
    )
    from ..models.developer_database_status_notification_delivery_backlog import (
        DeveloperDatabaseStatusNotificationDeliveryBacklog,
    )
    from ..models.developer_database_status_notification_delivery_last_heartbeat_type_0 import (
        DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0,
    )


T = TypeVar("T", bound="DeveloperDatabaseStatusNotificationDelivery")


@_attrs_define
class DeveloperDatabaseStatusNotificationDelivery:
    """
    Attributes:
        status (DeveloperDatabaseStatusNotificationDeliveryStatus):
        last_heartbeat (DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0 | None):
        backlog (DeveloperDatabaseStatusNotificationDeliveryBacklog):
        activation (DeveloperDatabaseStatusNotificationDeliveryActivation):
        checked_at (datetime.datetime):
    """

    status: DeveloperDatabaseStatusNotificationDeliveryStatus
    last_heartbeat: DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0 | None
    backlog: DeveloperDatabaseStatusNotificationDeliveryBacklog
    activation: DeveloperDatabaseStatusNotificationDeliveryActivation
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        from ..models.developer_database_status_notification_delivery_last_heartbeat_type_0 import (
            DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0,
        )

        status = self.status.value

        last_heartbeat: dict[str, Any] | None
        if isinstance(
            self.last_heartbeat, DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0
        ):
            last_heartbeat = self.last_heartbeat.to_dict()
        else:
            last_heartbeat = self.last_heartbeat

        backlog = self.backlog.to_dict()

        activation = self.activation.to_dict()

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "lastHeartbeat": last_heartbeat,
                "backlog": backlog,
                "activation": activation,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_database_status_notification_delivery_activation import (
            DeveloperDatabaseStatusNotificationDeliveryActivation,
        )
        from ..models.developer_database_status_notification_delivery_backlog import (
            DeveloperDatabaseStatusNotificationDeliveryBacklog,
        )
        from ..models.developer_database_status_notification_delivery_last_heartbeat_type_0 import (
            DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0,
        )

        d = dict(src_dict)
        status = DeveloperDatabaseStatusNotificationDeliveryStatus(d.pop("status"))

        def _parse_last_heartbeat(
            data: object,
        ) -> DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                last_heartbeat_type_0 = (
                    DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0.from_dict(data)
                )

                return last_heartbeat_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0 | None, data)

        last_heartbeat = _parse_last_heartbeat(d.pop("lastHeartbeat"))

        backlog = DeveloperDatabaseStatusNotificationDeliveryBacklog.from_dict(d.pop("backlog"))

        activation = DeveloperDatabaseStatusNotificationDeliveryActivation.from_dict(
            d.pop("activation")
        )

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        developer_database_status_notification_delivery = cls(
            status=status,
            last_heartbeat=last_heartbeat,
            backlog=backlog,
            activation=activation,
            checked_at=checked_at,
        )

        return developer_database_status_notification_delivery
