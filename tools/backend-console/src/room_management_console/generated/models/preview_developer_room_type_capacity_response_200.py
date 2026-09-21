from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_type_capacity_preview import DeveloperRoomTypeCapacityPreview


T = TypeVar("T", bound="PreviewDeveloperRoomTypeCapacityResponse200")


@_attrs_define
class PreviewDeveloperRoomTypeCapacityResponse200:
    """
    Attributes:
        preview (DeveloperRoomTypeCapacityPreview):
    """

    preview: DeveloperRoomTypeCapacityPreview

    def to_dict(self) -> dict[str, Any]:
        preview = self.preview.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "preview": preview,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_type_capacity_preview import DeveloperRoomTypeCapacityPreview

        d = dict(src_dict)
        preview = DeveloperRoomTypeCapacityPreview.from_dict(d.pop("preview"))

        preview_developer_room_type_capacity_response_200 = cls(
            preview=preview,
        )

        return preview_developer_room_type_capacity_response_200
