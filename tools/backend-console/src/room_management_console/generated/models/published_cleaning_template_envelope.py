from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.published_cleaning_template import PublishedCleaningTemplate


T = TypeVar("T", bound="PublishedCleaningTemplateEnvelope")


@_attrs_define
class PublishedCleaningTemplateEnvelope:
    """
    Attributes:
        template (PublishedCleaningTemplate):
    """

    template: PublishedCleaningTemplate

    def to_dict(self) -> dict[str, Any]:
        template = self.template.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "template": template,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.published_cleaning_template import PublishedCleaningTemplate

        d = dict(src_dict)
        template = PublishedCleaningTemplate.from_dict(d.pop("template"))

        published_cleaning_template_envelope = cls(
            template=template,
        )

        return published_cleaning_template_envelope
