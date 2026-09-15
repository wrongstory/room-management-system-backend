from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

from ..models.cleaning_template_room_type_code import CleaningTemplateRoomTypeCode
from ..types import UNSET, Unset

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
        slots (list[CleaningTemplateSlot]): v7+ checkout 계약: standard/premium/oceanPremium/oceanFamily 순으로 정확히
            10/11/13/15개, 필수는 총수-1, required tv-on은 정확히 한 개입니다. displayOrder는 0부터 연속입니다.
        duration_minutes (int | None | Unset): 선택적인 과거 호환 메타데이터입니다. 미입력/null이어도 예약을 차단하지 않으며 실제 청소시간은
            attempt.startedAt부터 fieldCompletedAt까지 계산합니다. 배정 Preview는 별도 확정 duration policy를 사용합니다.
    """

    room_type_code: CleaningTemplateRoomTypeCode
    cleaning_kind: Literal["checkout"]
    expected_version: int
    slots: list[CleaningTemplateSlot]
    duration_minutes: int | None | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        room_type_code = self.room_type_code.value

        cleaning_kind = self.cleaning_kind

        expected_version = self.expected_version

        slots = []
        for slots_item_data in self.slots:
            slots_item = slots_item_data.to_dict()
            slots.append(slots_item)

        duration_minutes: int | None | Unset
        if isinstance(self.duration_minutes, Unset):
            duration_minutes = UNSET
        else:
            duration_minutes = self.duration_minutes

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomTypeCode": room_type_code,
                "cleaningKind": cleaning_kind,
                "expectedVersion": expected_version,
                "slots": slots,
            }
        )
        if duration_minutes is not UNSET:
            field_dict["durationMinutes"] = duration_minutes

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

        slots = []
        _slots = d.pop("slots")
        for slots_item_data in _slots:
            slots_item = CleaningTemplateSlot.from_dict(slots_item_data)

            slots.append(slots_item)

        def _parse_duration_minutes(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        duration_minutes = _parse_duration_minutes(d.pop("durationMinutes", UNSET))

        publish_cleaning_template_request = cls(
            room_type_code=room_type_code,
            cleaning_kind=cleaning_kind,
            expected_version=expected_version,
            slots=slots,
            duration_minutes=duration_minutes,
        )

        return publish_cleaning_template_request
