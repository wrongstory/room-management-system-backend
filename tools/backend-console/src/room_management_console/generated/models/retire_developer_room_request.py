from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="RetireDeveloperRoomRequest")


@_attrs_define
class RetireDeveloperRoomRequest:
    """
    Attributes:
        expected_version (int):
        reason_code (str):
    """

    expected_version: int
    reason_code: str

    def to_dict(self) -> dict[str, Any]:
        expected_version = self.expected_version

        reason_code = self.reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "expectedVersion": expected_version,
                "reasonCode": reason_code,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        expected_version = d.pop("expectedVersion")

        reason_code = d.pop("reasonCode")

        retire_developer_room_request = cls(
            expected_version=expected_version,
            reason_code=reason_code,
        )

        return retire_developer_room_request
