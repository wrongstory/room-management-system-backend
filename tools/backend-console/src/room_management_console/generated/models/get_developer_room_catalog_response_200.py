from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_catalog import DeveloperRoomCatalog


T = TypeVar("T", bound="GetDeveloperRoomCatalogResponse200")


@_attrs_define
class GetDeveloperRoomCatalogResponse200:
    """
    Attributes:
        catalog (DeveloperRoomCatalog):
    """

    catalog: DeveloperRoomCatalog

    def to_dict(self) -> dict[str, Any]:
        catalog = self.catalog.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "catalog": catalog,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_catalog import DeveloperRoomCatalog

        d = dict(src_dict)
        catalog = DeveloperRoomCatalog.from_dict(d.pop("catalog"))

        get_developer_room_catalog_response_200 = cls(
            catalog=catalog,
        )

        return get_developer_room_catalog_response_200
