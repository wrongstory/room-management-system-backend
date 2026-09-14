from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.cleaning_template_room_type_state import CleaningTemplateRoomTypeState


T = TypeVar("T", bound="CleaningTemplateCatalog")


@_attrs_define
class CleaningTemplateCatalog:
    """
    Attributes:
        cleaning_kind (Literal['checkout']):
        room_types (list[CleaningTemplateRoomTypeState]):
    """

    cleaning_kind: Literal["checkout"]
    room_types: list[CleaningTemplateRoomTypeState]

    def to_dict(self) -> dict[str, Any]:
        cleaning_kind = self.cleaning_kind

        room_types = []
        for room_types_item_data in self.room_types:
            room_types_item = room_types_item_data.to_dict()
            room_types.append(room_types_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "cleaningKind": cleaning_kind,
                "roomTypes": room_types,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cleaning_template_room_type_state import CleaningTemplateRoomTypeState

        d = dict(src_dict)
        cleaning_kind = cast(Literal["checkout"], d.pop("cleaningKind"))
        if cleaning_kind != "checkout":
            raise ValueError(f"cleaningKind must match const 'checkout', got '{cleaning_kind}'")

        room_types = []
        _room_types = d.pop("roomTypes")
        for room_types_item_data in _room_types:
            room_types_item = CleaningTemplateRoomTypeState.from_dict(room_types_item_data)

            room_types.append(room_types_item)

        cleaning_template_catalog = cls(
            cleaning_kind=cleaning_kind,
            room_types=room_types,
        )

        return cleaning_template_catalog
