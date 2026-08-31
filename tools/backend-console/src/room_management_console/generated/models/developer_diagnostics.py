from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.developer_diagnostics_status import DeveloperDiagnosticsStatus

if TYPE_CHECKING:
    from ..models.developer_diagnostics_checks_item import DeveloperDiagnosticsChecksItem


T = TypeVar("T", bound="DeveloperDiagnostics")


@_attrs_define
class DeveloperDiagnostics:
    """
    Attributes:
        status (DeveloperDiagnosticsStatus):
        checks (list[DeveloperDiagnosticsChecksItem]):
        checked_at (datetime.datetime):
    """

    status: DeveloperDiagnosticsStatus
    checks: list[DeveloperDiagnosticsChecksItem]
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        status = self.status.value

        checks = []
        for checks_item_data in self.checks:
            checks_item = checks_item_data.to_dict()
            checks.append(checks_item)

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "checks": checks,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_diagnostics_checks_item import DeveloperDiagnosticsChecksItem

        d = dict(src_dict)
        status = DeveloperDiagnosticsStatus(d.pop("status"))

        checks = []
        _checks = d.pop("checks")
        for checks_item_data in _checks:
            checks_item = DeveloperDiagnosticsChecksItem.from_dict(checks_item_data)

            checks.append(checks_item)

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        developer_diagnostics = cls(
            status=status,
            checks=checks,
            checked_at=checked_at,
        )

        return developer_diagnostics
