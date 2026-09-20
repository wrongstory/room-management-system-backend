from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define

from ..models.developer_room_catalog_item_elevator_zone_type_1 import (
    DeveloperRoomCatalogItemElevatorZoneType1,
)
from ..models.developer_room_catalog_item_elevator_zone_type_2_type_1 import (
    DeveloperRoomCatalogItemElevatorZoneType2Type1,
)
from ..models.developer_room_catalog_item_elevator_zone_type_3_type_1 import (
    DeveloperRoomCatalogItemElevatorZoneType3Type1,
)
from ..models.developer_room_catalog_item_status import DeveloperRoomCatalogItemStatus
from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperRoomCatalogItem")


@_attrs_define
class DeveloperRoomCatalogItem:
    """
    Attributes:
        id (UUID):
        room_number (str):
        status (DeveloperRoomCatalogItemStatus):
        version (int):
        room_type_id (UUID):
        room_type_code (str):
        room_type_name (str):
        room_type_version (int):
        elevator_zone (DeveloperRoomCatalogItemElevatorZoneType1 | DeveloperRoomCatalogItemElevatorZoneType2Type1 |
            DeveloperRoomCatalogItemElevatorZoneType3Type1 | None):
        created_at (datetime.datetime):
        retired_at (datetime.datetime | None):
        retirement_reason_code (None | str | Unset):
    """

    id: UUID
    room_number: str
    status: DeveloperRoomCatalogItemStatus
    version: int
    room_type_id: UUID
    room_type_code: str
    room_type_name: str
    room_type_version: int
    elevator_zone: (
        DeveloperRoomCatalogItemElevatorZoneType1
        | DeveloperRoomCatalogItemElevatorZoneType2Type1
        | DeveloperRoomCatalogItemElevatorZoneType3Type1
        | None
    )
    created_at: datetime.datetime
    retired_at: datetime.datetime | None
    retirement_reason_code: None | str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        room_number = self.room_number

        status = self.status.value

        version = self.version

        room_type_id = str(self.room_type_id)

        room_type_code = self.room_type_code

        room_type_name = self.room_type_name

        room_type_version = self.room_type_version

        elevator_zone: None | str
        if isinstance(self.elevator_zone, DeveloperRoomCatalogItemElevatorZoneType1):
            elevator_zone = self.elevator_zone.value
        elif isinstance(self.elevator_zone, DeveloperRoomCatalogItemElevatorZoneType2Type1):
            elevator_zone = self.elevator_zone.value
        elif isinstance(self.elevator_zone, DeveloperRoomCatalogItemElevatorZoneType3Type1):
            elevator_zone = self.elevator_zone.value
        else:
            elevator_zone = self.elevator_zone

        created_at = self.created_at.isoformat()

        retired_at: None | str
        if isinstance(self.retired_at, datetime.datetime):
            retired_at = self.retired_at.isoformat()
        else:
            retired_at = self.retired_at

        retirement_reason_code: None | str | Unset
        if isinstance(self.retirement_reason_code, Unset):
            retirement_reason_code = UNSET
        else:
            retirement_reason_code = self.retirement_reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "roomNumber": room_number,
                "status": status,
                "version": version,
                "roomTypeId": room_type_id,
                "roomTypeCode": room_type_code,
                "roomTypeName": room_type_name,
                "roomTypeVersion": room_type_version,
                "elevatorZone": elevator_zone,
                "createdAt": created_at,
                "retiredAt": retired_at,
            }
        )
        if retirement_reason_code is not UNSET:
            field_dict["retirementReasonCode"] = retirement_reason_code

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        room_number = d.pop("roomNumber")

        status = DeveloperRoomCatalogItemStatus(d.pop("status"))

        version = d.pop("version")

        room_type_id = UUID(d.pop("roomTypeId"))

        room_type_code = d.pop("roomTypeCode")

        room_type_name = d.pop("roomTypeName")

        room_type_version = d.pop("roomTypeVersion")

        def _parse_elevator_zone(
            data: object,
        ) -> (
            DeveloperRoomCatalogItemElevatorZoneType1
            | DeveloperRoomCatalogItemElevatorZoneType2Type1
            | DeveloperRoomCatalogItemElevatorZoneType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                elevator_zone_type_1 = DeveloperRoomCatalogItemElevatorZoneType1(data)

                return elevator_zone_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                elevator_zone_type_2_type_1 = DeveloperRoomCatalogItemElevatorZoneType2Type1(data)

                return elevator_zone_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                elevator_zone_type_3_type_1 = DeveloperRoomCatalogItemElevatorZoneType3Type1(data)

                return elevator_zone_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                DeveloperRoomCatalogItemElevatorZoneType1
                | DeveloperRoomCatalogItemElevatorZoneType2Type1
                | DeveloperRoomCatalogItemElevatorZoneType3Type1
                | None,
                data,
            )

        elevator_zone = _parse_elevator_zone(d.pop("elevatorZone"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        def _parse_retired_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                retired_at_type_0 = datetime.datetime.fromisoformat(data)

                return retired_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        retired_at = _parse_retired_at(d.pop("retiredAt"))

        def _parse_retirement_reason_code(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        retirement_reason_code = _parse_retirement_reason_code(d.pop("retirementReasonCode", UNSET))

        developer_room_catalog_item = cls(
            id=id,
            room_number=room_number,
            status=status,
            version=version,
            room_type_id=room_type_id,
            room_type_code=room_type_code,
            room_type_name=room_type_name,
            room_type_version=room_type_version,
            elevator_zone=elevator_zone,
            created_at=created_at,
            retired_at=retired_at,
            retirement_reason_code=retirement_reason_code,
        )

        return developer_room_catalog_item
