from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define

from ..models.create_developer_room_request_elevator_zone_type_1 import (
    CreateDeveloperRoomRequestElevatorZoneType1,
)
from ..models.create_developer_room_request_elevator_zone_type_2_type_1 import (
    CreateDeveloperRoomRequestElevatorZoneType2Type1,
)
from ..models.create_developer_room_request_elevator_zone_type_3_type_1 import (
    CreateDeveloperRoomRequestElevatorZoneType3Type1,
)

T = TypeVar("T", bound="CreateDeveloperRoomRequest")


@_attrs_define
class CreateDeveloperRoomRequest:
    """
    Attributes:
        room_number (str):
        room_type_id (UUID):
        expected_room_type_version (int):
        elevator_zone (CreateDeveloperRoomRequestElevatorZoneType1 | CreateDeveloperRoomRequestElevatorZoneType2Type1 |
            CreateDeveloperRoomRequestElevatorZoneType3Type1 | None):
    """

    room_number: str
    room_type_id: UUID
    expected_room_type_version: int
    elevator_zone: (
        CreateDeveloperRoomRequestElevatorZoneType1
        | CreateDeveloperRoomRequestElevatorZoneType2Type1
        | CreateDeveloperRoomRequestElevatorZoneType3Type1
        | None
    )

    def to_dict(self) -> dict[str, Any]:
        room_number = self.room_number

        room_type_id = str(self.room_type_id)

        expected_room_type_version = self.expected_room_type_version

        elevator_zone: None | str
        if isinstance(self.elevator_zone, CreateDeveloperRoomRequestElevatorZoneType1):
            elevator_zone = self.elevator_zone.value
        elif isinstance(self.elevator_zone, CreateDeveloperRoomRequestElevatorZoneType2Type1):
            elevator_zone = self.elevator_zone.value
        elif isinstance(self.elevator_zone, CreateDeveloperRoomRequestElevatorZoneType3Type1):
            elevator_zone = self.elevator_zone.value
        else:
            elevator_zone = self.elevator_zone

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomNumber": room_number,
                "roomTypeId": room_type_id,
                "expectedRoomTypeVersion": expected_room_type_version,
                "elevatorZone": elevator_zone,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        room_number = d.pop("roomNumber")

        room_type_id = UUID(d.pop("roomTypeId"))

        expected_room_type_version = d.pop("expectedRoomTypeVersion")

        def _parse_elevator_zone(
            data: object,
        ) -> (
            CreateDeveloperRoomRequestElevatorZoneType1
            | CreateDeveloperRoomRequestElevatorZoneType2Type1
            | CreateDeveloperRoomRequestElevatorZoneType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                elevator_zone_type_1 = CreateDeveloperRoomRequestElevatorZoneType1(data)

                return elevator_zone_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                elevator_zone_type_2_type_1 = CreateDeveloperRoomRequestElevatorZoneType2Type1(data)

                return elevator_zone_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                elevator_zone_type_3_type_1 = CreateDeveloperRoomRequestElevatorZoneType3Type1(data)

                return elevator_zone_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                CreateDeveloperRoomRequestElevatorZoneType1
                | CreateDeveloperRoomRequestElevatorZoneType2Type1
                | CreateDeveloperRoomRequestElevatorZoneType3Type1
                | None,
                data,
            )

        elevator_zone = _parse_elevator_zone(d.pop("elevatorZone"))

        create_developer_room_request = cls(
            room_number=room_number,
            room_type_id=room_type_id,
            expected_room_type_version=expected_room_type_version,
            elevator_zone=elevator_zone,
        )

        return create_developer_room_request
