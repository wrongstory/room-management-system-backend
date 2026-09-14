from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="RoomPinSheetSyncStatusActivation")


@_attrs_define
class RoomPinSheetSyncStatusActivation:
    """
    Attributes:
        function_secrets_configured (bool):
        target_approved (bool):
    """

    function_secrets_configured: bool
    target_approved: bool

    def to_dict(self) -> dict[str, Any]:
        function_secrets_configured = self.function_secrets_configured

        target_approved = self.target_approved

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "functionSecretsConfigured": function_secrets_configured,
                "targetApproved": target_approved,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        function_secrets_configured = d.pop("functionSecretsConfigured")

        target_approved = d.pop("targetApproved")

        room_pin_sheet_sync_status_activation = cls(
            function_secrets_configured=function_secrets_configured,
            target_approved=target_approved,
        )

        return room_pin_sheet_sync_status_activation
