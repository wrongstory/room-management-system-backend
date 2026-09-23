from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

from ..models.developer_room_deactivation_preview_reason_codes_item import (
    DeveloperRoomDeactivationPreviewReasonCodesItem,
)

T = TypeVar("T", bound="DeveloperRoomDeactivationPreview")


@_attrs_define
class DeveloperRoomDeactivationPreview:
    """
    Attributes:
        room_id (UUID):
        currently_occupied (bool):
        active_future_reservation_count (int):
        active_cleaning_target_count (int):
        active_assignment_count (int):
        active_attempt_count (int):
        active_pin_change_lease (bool):
        unresolved_operation_count (int):
        can_deactivate (bool):
        reason_codes (list[DeveloperRoomDeactivationPreviewReasonCodesItem]):
        impact_fingerprint (str):
        evaluated_at (datetime.datetime):
        expires_at (datetime.datetime):
    """

    room_id: UUID
    currently_occupied: bool
    active_future_reservation_count: int
    active_cleaning_target_count: int
    active_assignment_count: int
    active_attempt_count: int
    active_pin_change_lease: bool
    unresolved_operation_count: int
    can_deactivate: bool
    reason_codes: list[DeveloperRoomDeactivationPreviewReasonCodesItem]
    impact_fingerprint: str
    evaluated_at: datetime.datetime
    expires_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        room_id = str(self.room_id)

        currently_occupied = self.currently_occupied

        active_future_reservation_count = self.active_future_reservation_count

        active_cleaning_target_count = self.active_cleaning_target_count

        active_assignment_count = self.active_assignment_count

        active_attempt_count = self.active_attempt_count

        active_pin_change_lease = self.active_pin_change_lease

        unresolved_operation_count = self.unresolved_operation_count

        can_deactivate = self.can_deactivate

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
                "roomId": room_id,
                "currentlyOccupied": currently_occupied,
                "activeFutureReservationCount": active_future_reservation_count,
                "activeCleaningTargetCount": active_cleaning_target_count,
                "activeAssignmentCount": active_assignment_count,
                "activeAttemptCount": active_attempt_count,
                "activePinChangeLease": active_pin_change_lease,
                "unresolvedOperationCount": unresolved_operation_count,
                "canDeactivate": can_deactivate,
                "reasonCodes": reason_codes,
                "impactFingerprint": impact_fingerprint,
                "evaluatedAt": evaluated_at,
                "expiresAt": expires_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        room_id = UUID(d.pop("roomId"))

        currently_occupied = d.pop("currentlyOccupied")

        active_future_reservation_count = d.pop("activeFutureReservationCount")

        active_cleaning_target_count = d.pop("activeCleaningTargetCount")

        active_assignment_count = d.pop("activeAssignmentCount")

        active_attempt_count = d.pop("activeAttemptCount")

        active_pin_change_lease = d.pop("activePinChangeLease")

        unresolved_operation_count = d.pop("unresolvedOperationCount")

        can_deactivate = d.pop("canDeactivate")

        reason_codes = []
        _reason_codes = d.pop("reasonCodes")
        for reason_codes_item_data in _reason_codes:
            reason_codes_item = DeveloperRoomDeactivationPreviewReasonCodesItem(
                reason_codes_item_data
            )

            reason_codes.append(reason_codes_item)

        impact_fingerprint = d.pop("impactFingerprint")

        evaluated_at = datetime.datetime.fromisoformat(d.pop("evaluatedAt"))

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        developer_room_deactivation_preview = cls(
            room_id=room_id,
            currently_occupied=currently_occupied,
            active_future_reservation_count=active_future_reservation_count,
            active_cleaning_target_count=active_cleaning_target_count,
            active_assignment_count=active_assignment_count,
            active_attempt_count=active_attempt_count,
            active_pin_change_lease=active_pin_change_lease,
            unresolved_operation_count=unresolved_operation_count,
            can_deactivate=can_deactivate,
            reason_codes=reason_codes,
            impact_fingerprint=impact_fingerprint,
            evaluated_at=evaluated_at,
            expires_at=expires_at,
        )

        return developer_room_deactivation_preview
