from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomTypeCapacityChangeRequest")


@_attrs_define
class DeveloperRoomTypeCapacityChangeRequest:
    """baseOccupancy는 maxOccupancy 이하여야 하며 preview와 모든 값이 같아야 합니다.

    Attributes:
        base_occupancy (int):
        max_occupancy (int):
        expected_version (int):
        impact_fingerprint (str):
        reason_code (Literal['CAPACITY_POLICY_CHANGE']):
    """

    base_occupancy: int
    max_occupancy: int
    expected_version: int
    impact_fingerprint: str
    reason_code: Literal["CAPACITY_POLICY_CHANGE"]

    def to_dict(self) -> dict[str, Any]:
        base_occupancy = self.base_occupancy

        max_occupancy = self.max_occupancy

        expected_version = self.expected_version

        impact_fingerprint = self.impact_fingerprint

        reason_code = self.reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "baseOccupancy": base_occupancy,
                "maxOccupancy": max_occupancy,
                "expectedVersion": expected_version,
                "impactFingerprint": impact_fingerprint,
                "reasonCode": reason_code,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        base_occupancy = d.pop("baseOccupancy")

        max_occupancy = d.pop("maxOccupancy")

        expected_version = d.pop("expectedVersion")

        impact_fingerprint = d.pop("impactFingerprint")

        reason_code = cast(Literal["CAPACITY_POLICY_CHANGE"], d.pop("reasonCode"))
        if reason_code != "CAPACITY_POLICY_CHANGE":
            raise ValueError(
                f"reasonCode must match const 'CAPACITY_POLICY_CHANGE', got '{reason_code}'"
            )

        developer_room_type_capacity_change_request = cls(
            base_occupancy=base_occupancy,
            max_occupancy=max_occupancy,
            expected_version=expected_version,
            impact_fingerprint=impact_fingerprint,
            reason_code=reason_code,
        )

        return developer_room_type_capacity_change_request
