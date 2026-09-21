from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRoomTypeCatalogItem")


@_attrs_define
class DeveloperRoomTypeCatalogItem:
    """
    Attributes:
        id (UUID):
        code (str):
        display_name (str):
        base_occupancy (int):
        max_occupancy (int):
        active (bool):
        version (int):
        room_count (int):
    """

    id: UUID
    code: str
    display_name: str
    base_occupancy: int
    max_occupancy: int
    active: bool
    version: int
    room_count: int

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        code = self.code

        display_name = self.display_name

        base_occupancy = self.base_occupancy

        max_occupancy = self.max_occupancy

        active = self.active

        version = self.version

        room_count = self.room_count

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "code": code,
                "displayName": display_name,
                "baseOccupancy": base_occupancy,
                "maxOccupancy": max_occupancy,
                "active": active,
                "version": version,
                "roomCount": room_count,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        code = d.pop("code")

        display_name = d.pop("displayName")

        base_occupancy = d.pop("baseOccupancy")

        max_occupancy = d.pop("maxOccupancy")

        active = d.pop("active")

        version = d.pop("version")

        room_count = d.pop("roomCount")

        developer_room_type_catalog_item = cls(
            id=id,
            code=code,
            display_name=display_name,
            base_occupancy=base_occupancy,
            max_occupancy=max_occupancy,
            active=active,
            version=version,
            room_count=room_count,
        )

        return developer_room_type_catalog_item
