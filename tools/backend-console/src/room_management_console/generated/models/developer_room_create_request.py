from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomCreateRequest")


@_attrs_define
class DeveloperRoomCreateRequest:
    """
    Attributes:
        room_number (str):
        room_type_id (UUID):
        expected_room_type_version (int):
        reason_code (Literal['ROOM_CATALOG_ADD']):
    """

    room_number: str
    room_type_id: UUID
    expected_room_type_version: int
    reason_code: Literal["ROOM_CATALOG_ADD"]

    def to_dict(self) -> dict[str, Any]:
        room_number = self.room_number

        room_type_id = str(self.room_type_id)

        expected_room_type_version = self.expected_room_type_version

        reason_code = self.reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomNumber": room_number,
                "roomTypeId": room_type_id,
                "expectedRoomTypeVersion": expected_room_type_version,
                "reasonCode": reason_code,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        room_number = d.pop("roomNumber")

        room_type_id = UUID(d.pop("roomTypeId"))

        expected_room_type_version = d.pop("expectedRoomTypeVersion")

        reason_code = cast(Literal["ROOM_CATALOG_ADD"], d.pop("reasonCode"))
        if reason_code != "ROOM_CATALOG_ADD":
            raise ValueError(f"reasonCode must match const 'ROOM_CATALOG_ADD', got '{reason_code}'")

        developer_room_create_request = cls(
            room_number=room_number,
            room_type_id=room_type_id,
            expected_room_type_version=expected_room_type_version,
            reason_code=reason_code,
        )

        return developer_room_create_request
