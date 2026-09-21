from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomDeactivationRequest")


@_attrs_define
class DeveloperRoomDeactivationRequest:
    """
    Attributes:
        expected_version (int):
        impact_fingerprint (str):
        reason_code (Literal['ROOM_CATALOG_REMOVE']):
    """

    expected_version: int
    impact_fingerprint: str
    reason_code: Literal["ROOM_CATALOG_REMOVE"]

    def to_dict(self) -> dict[str, Any]:
        expected_version = self.expected_version

        impact_fingerprint = self.impact_fingerprint

        reason_code = self.reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "expectedVersion": expected_version,
                "impactFingerprint": impact_fingerprint,
                "reasonCode": reason_code,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        expected_version = d.pop("expectedVersion")

        impact_fingerprint = d.pop("impactFingerprint")

        reason_code = cast(Literal["ROOM_CATALOG_REMOVE"], d.pop("reasonCode"))
        if reason_code != "ROOM_CATALOG_REMOVE":
            raise ValueError(
                f"reasonCode must match const 'ROOM_CATALOG_REMOVE', got '{reason_code}'"
            )

        developer_room_deactivation_request = cls(
            expected_version=expected_version,
            impact_fingerprint=impact_fingerprint,
            reason_code=reason_code,
        )

        return developer_room_deactivation_request
