from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.cleaning_template_catalog import CleaningTemplateCatalog


T = TypeVar("T", bound="CleaningTemplateCatalogEnvelope")


@_attrs_define
class CleaningTemplateCatalogEnvelope:
    """
    Attributes:
        templates (CleaningTemplateCatalog):
    """

    templates: CleaningTemplateCatalog

    def to_dict(self) -> dict[str, Any]:
        templates = self.templates.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "templates": templates,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cleaning_template_catalog import CleaningTemplateCatalog

        d = dict(src_dict)
        templates = CleaningTemplateCatalog.from_dict(d.pop("templates"))

        cleaning_template_catalog_envelope = cls(
            templates=templates,
        )

        return cleaning_template_catalog_envelope
