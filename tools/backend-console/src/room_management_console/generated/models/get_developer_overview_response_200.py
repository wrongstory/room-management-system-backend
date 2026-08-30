from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_overview import DeveloperOverview


T = TypeVar("T", bound="GetDeveloperOverviewResponse200")


@_attrs_define
class GetDeveloperOverviewResponse200:
    """
    Attributes:
        overview (DeveloperOverview):
    """

    overview: DeveloperOverview

    def to_dict(self) -> dict[str, Any]:
        overview = self.overview.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "overview": overview,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_overview import DeveloperOverview

        d = dict(src_dict)
        overview = DeveloperOverview.from_dict(d.pop("overview"))

        get_developer_overview_response_200 = cls(
            overview=overview,
        )

        return get_developer_overview_response_200
