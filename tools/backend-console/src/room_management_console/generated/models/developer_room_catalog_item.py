from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomCatalogItem")


@_attrs_define
class DeveloperRoomCatalogItem:
    """
    Attributes:
        id (UUID):
        room_number (str):
        room_type_id (UUID):
        room_type_code (str):
        active (bool):
        version (int):
    """

    id: UUID
    room_number: str
    room_type_id: UUID
    room_type_code: str
    active: bool
    version: int

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        room_number = self.room_number

        room_type_id = str(self.room_type_id)

        room_type_code = self.room_type_code

        active = self.active

        version = self.version

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "roomNumber": room_number,
                "roomTypeId": room_type_id,
                "roomTypeCode": room_type_code,
                "active": active,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        room_number = d.pop("roomNumber")

        room_type_id = UUID(d.pop("roomTypeId"))

        room_type_code = d.pop("roomTypeCode")

        active = d.pop("active")

        version = d.pop("version")

        developer_room_catalog_item = cls(
            id=id,
            room_number=room_number,
            room_type_id=room_type_id,
            room_type_code=room_type_code,
            active=active,
            version=version,
        )

        return developer_room_catalog_item
