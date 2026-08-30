from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_diagnostics import DeveloperDiagnostics


T = TypeVar("T", bound="RunDeveloperDiagnosticsResponse200")


@_attrs_define
class RunDeveloperDiagnosticsResponse200:
    """
    Attributes:
        diagnostics (DeveloperDiagnostics):
    """

    diagnostics: DeveloperDiagnostics

    def to_dict(self) -> dict[str, Any]:
        diagnostics = self.diagnostics.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "diagnostics": diagnostics,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_diagnostics import DeveloperDiagnostics

        d = dict(src_dict)
        diagnostics = DeveloperDiagnostics.from_dict(d.pop("diagnostics"))

        run_developer_diagnostics_response_200 = cls(
            diagnostics=diagnostics,
        )

        return run_developer_diagnostics_response_200
