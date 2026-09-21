from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomDeactivationPreviewRequest")


@_attrs_define
class DeveloperRoomDeactivationPreviewRequest:
    """
    Attributes:
        expected_version (int):
    """

    expected_version: int

    def to_dict(self) -> dict[str, Any]:
        expected_version = self.expected_version

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "expectedVersion": expected_version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        expected_version = d.pop("expectedVersion")

        developer_room_deactivation_preview_request = cls(
            expected_version=expected_version,
        )

        return developer_room_deactivation_preview_request
