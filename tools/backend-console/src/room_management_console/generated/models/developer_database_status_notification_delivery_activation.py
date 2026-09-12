from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperDatabaseStatusNotificationDeliveryActivation")


@_attrs_define
class DeveloperDatabaseStatusNotificationDeliveryActivation:
    """
    Attributes:
        cron_configured (bool):
        cron_active (bool):
        function_secrets_configured (bool):
    """

    cron_configured: bool
    cron_active: bool
    function_secrets_configured: bool

    def to_dict(self) -> dict[str, Any]:
        cron_configured = self.cron_configured

        cron_active = self.cron_active

        function_secrets_configured = self.function_secrets_configured

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "cronConfigured": cron_configured,
                "cronActive": cron_active,
                "functionSecretsConfigured": function_secrets_configured,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        cron_configured = d.pop("cronConfigured")

        cron_active = d.pop("cronActive")

        function_secrets_configured = d.pop("functionSecretsConfigured")

        developer_database_status_notification_delivery_activation = cls(
            cron_configured=cron_configured,
            cron_active=cron_active,
            function_secrets_configured=function_secrets_configured,
        )

        return developer_database_status_notification_delivery_activation
