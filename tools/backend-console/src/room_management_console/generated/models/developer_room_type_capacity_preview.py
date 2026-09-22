from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

from ..models.developer_room_type_capacity_preview_reason_codes_item import (
    DeveloperRoomTypeCapacityPreviewReasonCodesItem,
)

if TYPE_CHECKING:
    from ..models.developer_room_type_capacity_preview_current import (
        DeveloperRoomTypeCapacityPreviewCurrent,
    )
    from ..models.developer_room_type_capacity_preview_proposed import (
        DeveloperRoomTypeCapacityPreviewProposed,
    )


T = TypeVar("T", bound="DeveloperRoomTypeCapacityPreview")


@_attrs_define
class DeveloperRoomTypeCapacityPreview:
    """
    Attributes:
        room_type_id (UUID):
        current (DeveloperRoomTypeCapacityPreviewCurrent):
        proposed (DeveloperRoomTypeCapacityPreviewProposed):
        room_count (int):
        active_reservation_count (int):
        exceeding_active_reservation_count (int):
        reason_codes (list[DeveloperRoomTypeCapacityPreviewReasonCodesItem]):
        impact_fingerprint (str):
        evaluated_at (datetime.datetime):
        expires_at (datetime.datetime):
    """

    room_type_id: UUID
    current: DeveloperRoomTypeCapacityPreviewCurrent
    proposed: DeveloperRoomTypeCapacityPreviewProposed
    room_count: int
    active_reservation_count: int
    exceeding_active_reservation_count: int
    reason_codes: list[DeveloperRoomTypeCapacityPreviewReasonCodesItem]
    impact_fingerprint: str
    evaluated_at: datetime.datetime
    expires_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        room_type_id = str(self.room_type_id)

        current = self.current.to_dict()

        proposed = self.proposed.to_dict()

        room_count = self.room_count

        active_reservation_count = self.active_reservation_count

        exceeding_active_reservation_count = self.exceeding_active_reservation_count

        reason_codes = []
        for reason_codes_item_data in self.reason_codes:
            reason_codes_item = reason_codes_item_data.value
            reason_codes.append(reason_codes_item)

        impact_fingerprint = self.impact_fingerprint

        evaluated_at = self.evaluated_at.isoformat()

        expires_at = self.expires_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomTypeId": room_type_id,
                "current": current,
                "proposed": proposed,
                "roomCount": room_count,
                "activeReservationCount": active_reservation_count,
                "exceedingActiveReservationCount": exceeding_active_reservation_count,
                "reasonCodes": reason_codes,
                "impactFingerprint": impact_fingerprint,
                "evaluatedAt": evaluated_at,
                "expiresAt": expires_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_type_capacity_preview_current import (
            DeveloperRoomTypeCapacityPreviewCurrent,
        )
        from ..models.developer_room_type_capacity_preview_proposed import (
            DeveloperRoomTypeCapacityPreviewProposed,
        )

        d = dict(src_dict)
        room_type_id = UUID(d.pop("roomTypeId"))

        current = DeveloperRoomTypeCapacityPreviewCurrent.from_dict(d.pop("current"))

        proposed = DeveloperRoomTypeCapacityPreviewProposed.from_dict(d.pop("proposed"))

        room_count = d.pop("roomCount")

        active_reservation_count = d.pop("activeReservationCount")

        exceeding_active_reservation_count = d.pop("exceedingActiveReservationCount")

        reason_codes = []
        _reason_codes = d.pop("reasonCodes")
        for reason_codes_item_data in _reason_codes:
            reason_codes_item = DeveloperRoomTypeCapacityPreviewReasonCodesItem(
                reason_codes_item_data
            )

            reason_codes.append(reason_codes_item)

        impact_fingerprint = d.pop("impactFingerprint")

        evaluated_at = datetime.datetime.fromisoformat(d.pop("evaluatedAt"))

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        developer_room_type_capacity_preview = cls(
            room_type_id=room_type_id,
            current=current,
            proposed=proposed,
            room_count=room_count,
            active_reservation_count=active_reservation_count,
            exceeding_active_reservation_count=exceeding_active_reservation_count,
            reason_codes=reason_codes,
            impact_fingerprint=impact_fingerprint,
            evaluated_at=evaluated_at,
            expires_at=expires_at,
        )

        return developer_room_type_capacity_preview
