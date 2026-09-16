from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="CheckoutCleaningTemplateV8Slot")


@_attrs_define
class CheckoutCleaningTemplateV8Slot:
    """
    Attributes:
        slot_key (str):
        display_order (int):
        required (bool):
        label (str):
        max_photos (int): Decision A v8+ 필수 메타데이터입니다. pre-A historical v7+ projection에는 없을 수 있습니다.
        description (str | Unset):
        section (str | Unset):
        instance_key (str | Unset):
    """

    slot_key: str
    display_order: int
    required: bool
    label: str
    max_photos: int
    description: str | Unset = UNSET
    section: str | Unset = UNSET
    instance_key: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        slot_key = self.slot_key

        display_order = self.display_order

        required = self.required

        label = self.label

        max_photos = self.max_photos

        description = self.description

        section = self.section

        instance_key = self.instance_key

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "slotKey": slot_key,
                "displayOrder": display_order,
                "required": required,
                "label": label,
                "maxPhotos": max_photos,
            }
        )
        if description is not UNSET:
            field_dict["description"] = description
        if section is not UNSET:
            field_dict["section"] = section
        if instance_key is not UNSET:
            field_dict["instanceKey"] = instance_key

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        slot_key = d.pop("slotKey")

        display_order = d.pop("displayOrder")

        required = d.pop("required")

        label = d.pop("label")

        max_photos = d.pop("maxPhotos")

        description = d.pop("description", UNSET)

        section = d.pop("section", UNSET)

        instance_key = d.pop("instanceKey", UNSET)

        checkout_cleaning_template_v8_slot = cls(
            slot_key=slot_key,
            display_order=display_order,
            required=required,
            label=label,
            max_photos=max_photos,
            description=description,
            section=section,
            instance_key=instance_key,
        )

        checkout_cleaning_template_v8_slot.additional_properties = d
        return checkout_cleaning_template_v8_slot

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
