from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperRuntimeStatusRuntime")


@_attrs_define
class DeveloperRuntimeStatusRuntime:
    """
    Attributes:
        name (Literal['deno']):
        version (str):
    """

    name: Literal["deno"]
    version: str

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        version = self.version

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "name": name,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = cast(Literal["deno"], d.pop("name"))
        if name != "deno":
            raise ValueError(f"name must match const 'deno', got '{name}'")

        version = d.pop("version")

        developer_runtime_status_runtime = cls(
            name=name,
            version=version,
        )

        return developer_runtime_status_runtime
