from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.status_change_request_status import StatusChangeRequestStatus

T = TypeVar("T", bound="StatusChangeRequest")


@_attrs_define
class StatusChangeRequest:
    """
    Attributes:
        status (StatusChangeRequestStatus): 퇴사는 active에서 바로 전이할 수 없습니다. 먼저 inactive로 변경한 뒤 departed로 처리합니다.
        reason_code (str): 감사 이력에 남는 안정적인 영문 대문자 사유 코드. 자유입력 문구를 보내지 않습니다.
    """

    status: StatusChangeRequestStatus
    reason_code: str

    def to_dict(self) -> dict[str, Any]:
        status = self.status.value

        reason_code = self.reason_code

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "reasonCode": reason_code,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = StatusChangeRequestStatus(d.pop("status"))

        reason_code = d.pop("reasonCode")

        status_change_request = cls(
            status=status,
            reason_code=reason_code,
        )

        return status_change_request
