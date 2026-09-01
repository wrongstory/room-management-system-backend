from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="PasswordChangeRequest")


@_attrs_define
class PasswordChangeRequest:
    """
    Attributes:
        current_password (str): 현재 4자리 임시 비밀번호 또는 현재 개인 비밀번호
        new_password (str): 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합
    """

    current_password: str
    new_password: str

    def to_dict(self) -> dict[str, Any]:
        current_password = self.current_password

        new_password = self.new_password

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "currentPassword": current_password,
                "newPassword": new_password,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        current_password = d.pop("currentPassword")

        new_password = d.pop("newPassword")

        password_change_request = cls(
            current_password=current_password,
            new_password=new_password,
        )

        return password_change_request
