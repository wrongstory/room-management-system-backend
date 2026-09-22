from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.cleaning_template_slot import CleaningTemplateSlot


T = TypeVar("T", bound="PublishedCleaningTemplate")


@_attrs_define
class PublishedCleaningTemplate:
    """
    Attributes:
        id (UUID):
        version (int):
        status (Literal['published']):
        duration_minutes (int | None): 미설정 가능. 실제 청소시간이나 배정 Preview 정책의 정본이 아닙니다.
        slots (list[CleaningTemplateSlot]): maxPhotos 없는 pre-A historical v7+ template은 10/11/13/15개이고, 모든 slot에
            metadata가 있는 A-contract v8+ template은 9/10/12/14개입니다.
        published_at (datetime.datetime):
        created_at (datetime.datetime):
    """

    id: UUID
    version: int
    status: Literal["published"]
    duration_minutes: int | None
    slots: list[CleaningTemplateSlot]
    published_at: datetime.datetime
    created_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        version = self.version

        status = self.status

        duration_minutes: int | None
        duration_minutes = self.duration_minutes

        slots = []
        for slots_item_data in self.slots:
            slots_item = slots_item_data.to_dict()
            slots.append(slots_item)

        published_at = self.published_at.isoformat()

        created_at = self.created_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "version": version,
                "status": status,
                "durationMinutes": duration_minutes,
                "slots": slots,
                "publishedAt": published_at,
                "createdAt": created_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cleaning_template_slot import CleaningTemplateSlot

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        version = d.pop("version")

        status = cast(Literal["published"], d.pop("status"))
        if status != "published":
            raise ValueError(f"status must match const 'published', got '{status}'")

        def _parse_duration_minutes(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        duration_minutes = _parse_duration_minutes(d.pop("durationMinutes"))

        slots = []
        _slots = d.pop("slots")
        for slots_item_data in _slots:
            slots_item = CleaningTemplateSlot.from_dict(slots_item_data)

            slots.append(slots_item)

        published_at = datetime.datetime.fromisoformat(d.pop("publishedAt"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        published_cleaning_template = cls(
            id=id,
            version=version,
            status=status,
            duration_minutes=duration_minutes,
            slots=slots,
            published_at=published_at,
            created_at=created_at,
        )

        return published_cleaning_template
