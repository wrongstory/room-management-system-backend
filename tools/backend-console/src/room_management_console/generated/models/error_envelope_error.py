from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.error_code import ErrorCode

T = TypeVar("T", bound="ErrorEnvelopeError")


@_attrs_define
class ErrorEnvelopeError:
    """
    Attributes:
        code (ErrorCode): 프론트 분기용 안정적 코드입니다. 사용자 표시 문구는 message가 아니라 이 코드 기준으로 관리합니다.
        message (str): 현재 요청을 위한 한국어 안내입니다. 장기적인 프론트 분기는 error.code를 사용합니다.
    """

    code: ErrorCode
    message: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        code = self.code.value

        message = self.message

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "message": message,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        code = ErrorCode(d.pop("code"))

        message = d.pop("message")

        error_envelope_error = cls(
            code=code,
            message=message,
        )

        error_envelope_error.additional_properties = d
        return error_envelope_error

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
