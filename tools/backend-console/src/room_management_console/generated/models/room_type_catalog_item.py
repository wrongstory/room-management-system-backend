from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

T = TypeVar("T", bound="RoomTypeCatalogItem")


@_attrs_define
class RoomTypeCatalogItem:
    """
    Attributes:
        id (UUID):
        code (str): 불변 타입 코드
        display_name (str): 현재 표시명
        base_cleaning_fee (int): 원 단위 기본 청소비
        active (bool): 신규 객실 기준정보 선택 가능 여부
        version (int): 실제 객실 타입 변경 시 증가하는 버전
        room_count (int): 현재 참조 객실 수
    """

    id: UUID
    code: str
    display_name: str
    base_cleaning_fee: int
    active: bool
    version: int
    room_count: int

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        code = self.code

        display_name = self.display_name

        base_cleaning_fee = self.base_cleaning_fee

        active = self.active

        version = self.version

        room_count = self.room_count

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "code": code,
                "displayName": display_name,
                "baseCleaningFee": base_cleaning_fee,
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

        base_cleaning_fee = d.pop("baseCleaningFee")

        active = d.pop("active")

        version = d.pop("version")

        room_count = d.pop("roomCount")

        room_type_catalog_item = cls(
            id=id,
            code=code,
            display_name=display_name,
            base_cleaning_fee=base_cleaning_fee,
            active=active,
            version=version,
            room_count=room_count,
        )

        return room_type_catalog_item
