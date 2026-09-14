from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

from ..models.cleaning_template_room_type_code import CleaningTemplateRoomTypeCode

if TYPE_CHECKING:
    from ..models.cleaning_template_slot import CleaningTemplateSlot


T = TypeVar("T", bound="PublishCleaningTemplateRequest")


@_attrs_define
class PublishCleaningTemplateRequest:
    """
    Attributes:
        room_type_code (CleaningTemplateRoomTypeCode):
        cleaning_kind (Literal['checkout']):
        expected_version (int):
        duration_minutes (int):
        slots (list[CleaningTemplateSlot]): v7+ checkout 계약: standard/premium/oceanPremium/oceanFamily 순으로 정확히
            10/11/13/15개, 필수는 총수-1, required tv-on은 정확히 한 개입니다. displayOrder는 0부터 연속입니다.
    """

    room_type_code: CleaningTemplateRoomTypeCode
    cleaning_kind: Literal["checkout"]
    expected_version: int
    duration_minutes: int
    slots: list[CleaningTemplateSlot]

    def to_dict(self) -> dict[str, Any]:
        room_type_code = self.room_type_code.value

        cleaning_kind = self.cleaning_kind

        expected_version = self.expected_version

        duration_minutes = self.duration_minutes

        slots = []
        for slots_item_data in self.slots:
            slots_item = slots_item_data.to_dict()
            slots.append(slots_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomTypeCode": room_type_code,
                "cleaningKind": cleaning_kind,
                "expectedVersion": expected_version,
                "durationMinutes": duration_minutes,
                "slots": slots,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cleaning_template_slot import CleaningTemplateSlot

        d = dict(src_dict)
        room_type_code = CleaningTemplateRoomTypeCode(d.pop("roomTypeCode"))

        cleaning_kind = cast(Literal["checkout"], d.pop("cleaningKind"))
        if cleaning_kind != "checkout":
            raise ValueError(f"cleaningKind must match const 'checkout', got '{cleaning_kind}'")

        expected_version = d.pop("expectedVersion")

        duration_minutes = d.pop("durationMinutes")

        slots = []
        _slots = d.pop("slots")
        for slots_item_data in _slots:
            slots_item = CleaningTemplateSlot.from_dict(slots_item_data)

            slots.append(slots_item)

        publish_cleaning_template_request = cls(
            room_type_code=room_type_code,
            cleaning_kind=cleaning_kind,
            expected_version=expected_version,
            duration_minutes=duration_minutes,
            slots=slots,
        )

        return publish_cleaning_template_request
