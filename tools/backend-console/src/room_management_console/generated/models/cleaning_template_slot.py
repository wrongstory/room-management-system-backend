from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="CleaningTemplateSlot")


@_attrs_define
class CleaningTemplateSlot:
    """
    Attributes:
        slot_key (str):
        display_order (int):
        required (bool):
        label (str):
        description (str | Unset):
        section (str | Unset):
        instance_key (str | Unset):
    """

    slot_key: str
    display_order: int
    required: bool
    label: str
    description: str | Unset = UNSET
    section: str | Unset = UNSET
    instance_key: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        slot_key = self.slot_key

        display_order = self.display_order

        required = self.required

        label = self.label

        description = self.description

        section = self.section

        instance_key = self.instance_key

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "slotKey": slot_key,
                "displayOrder": display_order,
                "required": required,
                "label": label,
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

        description = d.pop("description", UNSET)

        section = d.pop("section", UNSET)

        instance_key = d.pop("instanceKey", UNSET)

        cleaning_template_slot = cls(
            slot_key=slot_key,
            display_order=display_order,
            required=required,
            label=label,
            description=description,
            section=section,
            instance_key=instance_key,
        )

        return cleaning_template_slot
