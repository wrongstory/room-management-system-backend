from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.developer_diagnostics_checks_item_status import DeveloperDiagnosticsChecksItemStatus
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.developer_diagnostics_checks_item_detail import (
        DeveloperDiagnosticsChecksItemDetail,
    )


T = TypeVar("T", bound="DeveloperDiagnosticsChecksItem")


@_attrs_define
class DeveloperDiagnosticsChecksItem:
    """
    Attributes:
        id (str):
        status (DeveloperDiagnosticsChecksItemStatus):
        error_code (str | Unset):
        detail (DeveloperDiagnosticsChecksItemDetail | Unset):
    """

    id: str
    status: DeveloperDiagnosticsChecksItemStatus
    error_code: str | Unset = UNSET
    detail: DeveloperDiagnosticsChecksItemDetail | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        status = self.status.value

        error_code = self.error_code

        detail: dict[str, Any] | Unset = UNSET
        if not isinstance(self.detail, Unset):
            detail = self.detail.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "status": status,
            }
        )
        if error_code is not UNSET:
            field_dict["errorCode"] = error_code
        if detail is not UNSET:
            field_dict["detail"] = detail

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_diagnostics_checks_item_detail import (
            DeveloperDiagnosticsChecksItemDetail,
        )

        d = dict(src_dict)
        id = d.pop("id")

        status = DeveloperDiagnosticsChecksItemStatus(d.pop("status"))

        error_code = d.pop("errorCode", UNSET)

        _detail = d.pop("detail", UNSET)
        detail: DeveloperDiagnosticsChecksItemDetail | Unset
        if isinstance(_detail, Unset):
            detail = UNSET
        else:
            detail = DeveloperDiagnosticsChecksItemDetail.from_dict(_detail)

        developer_diagnostics_checks_item = cls(
            id=id,
            status=status,
            error_code=error_code,
            detail=detail,
        )

        return developer_diagnostics_checks_item
