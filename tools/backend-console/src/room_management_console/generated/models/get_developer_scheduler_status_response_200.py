from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_scheduler_status import DeveloperSchedulerStatus


T = TypeVar("T", bound="GetDeveloperSchedulerStatusResponse200")


@_attrs_define
class GetDeveloperSchedulerStatusResponse200:
    """
    Attributes:
        scheduler (DeveloperSchedulerStatus):
    """

    scheduler: DeveloperSchedulerStatus

    def to_dict(self) -> dict[str, Any]:
        scheduler = self.scheduler.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "scheduler": scheduler,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_scheduler_status import DeveloperSchedulerStatus

        d = dict(src_dict)
        scheduler = DeveloperSchedulerStatus.from_dict(d.pop("scheduler"))

        get_developer_scheduler_status_response_200 = cls(
            scheduler=scheduler,
        )

        return get_developer_scheduler_status_response_200
