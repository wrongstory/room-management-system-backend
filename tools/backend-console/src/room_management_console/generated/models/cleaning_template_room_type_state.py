from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

from ..models.cleaning_template_room_type_code import CleaningTemplateRoomTypeCode

if TYPE_CHECKING:
    from ..models.published_cleaning_template import PublishedCleaningTemplate


T = TypeVar("T", bound="CleaningTemplateRoomTypeState")


@_attrs_define
class CleaningTemplateRoomTypeState:
    """
    Attributes:
        room_type_code (CleaningTemplateRoomTypeCode):
        room_type_name (str):
        cleaning_kind (Literal['checkout']):
        configured (bool):
        expected_version (int):
        current_published (None | PublishedCleaningTemplate):
    """

    room_type_code: CleaningTemplateRoomTypeCode
    room_type_name: str
    cleaning_kind: Literal["checkout"]
    configured: bool
    expected_version: int
    current_published: None | PublishedCleaningTemplate

    def to_dict(self) -> dict[str, Any]:
        from ..models.published_cleaning_template import PublishedCleaningTemplate

        room_type_code = self.room_type_code.value

        room_type_name = self.room_type_name

        cleaning_kind = self.cleaning_kind

        configured = self.configured

        expected_version = self.expected_version

        current_published: dict[str, Any] | None
        if isinstance(self.current_published, PublishedCleaningTemplate):
            current_published = self.current_published.to_dict()
        else:
            current_published = self.current_published

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "roomTypeCode": room_type_code,
                "roomTypeName": room_type_name,
                "cleaningKind": cleaning_kind,
                "configured": configured,
                "expectedVersion": expected_version,
                "currentPublished": current_published,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.published_cleaning_template import PublishedCleaningTemplate

        d = dict(src_dict)
        room_type_code = CleaningTemplateRoomTypeCode(d.pop("roomTypeCode"))

        room_type_name = d.pop("roomTypeName")

        cleaning_kind = cast(Literal["checkout"], d.pop("cleaningKind"))
        if cleaning_kind != "checkout":
            raise ValueError(f"cleaningKind must match const 'checkout', got '{cleaning_kind}'")

        configured = d.pop("configured")

        expected_version = d.pop("expectedVersion")

        def _parse_current_published(data: object) -> None | PublishedCleaningTemplate:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                current_published_type_0 = PublishedCleaningTemplate.from_dict(data)

                return current_published_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | PublishedCleaningTemplate, data)

        current_published = _parse_current_published(d.pop("currentPublished"))

        cleaning_template_room_type_state = cls(
            room_type_code=room_type_code,
            room_type_name=room_type_name,
            cleaning_kind=cleaning_kind,
            configured=configured,
            expected_version=expected_version,
            current_published=current_published,
        )

        return cleaning_template_room_type_state
