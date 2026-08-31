from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_runtime_status import DeveloperRuntimeStatus


T = TypeVar("T", bound="GetDeveloperRuntimeStatusResponse200")


@_attrs_define
class GetDeveloperRuntimeStatusResponse200:
    """
    Attributes:
        runtime (DeveloperRuntimeStatus):
    """

    runtime: DeveloperRuntimeStatus

    def to_dict(self) -> dict[str, Any]:
        runtime = self.runtime.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "runtime": runtime,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_runtime_status import DeveloperRuntimeStatus

        d = dict(src_dict)
        runtime = DeveloperRuntimeStatus.from_dict(d.pop("runtime"))

        get_developer_runtime_status_response_200 = cls(
            runtime=runtime,
        )

        return get_developer_runtime_status_response_200
