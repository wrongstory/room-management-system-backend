from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64")


@_attrs_define
class DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64:
    """
    Attributes:
        configured (bool):
    """

    configured: bool

    def to_dict(self) -> dict[str, Any]:
        configured = self.configured

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "configured": configured,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        configured = d.pop("configured")

        developer_runtime_status_configuration_roompinkeybase64 = cls(
            configured=configured,
        )

        return developer_runtime_status_configuration_roompinkeybase64
