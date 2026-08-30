from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="LoginRequest")


@_attrs_define
class LoginRequest:
    """
    Attributes:
        login_id (str): 사용자에게 발급된 이름형 로그인 ID. 서버가 NFKC·trim·소문자로 정규화합니다.
        password (str): 최초/초기화 시 휴대전화 뒤 4자리 또는 허용된 개인 비밀번호
    """

    login_id: str
    password: str

    def to_dict(self) -> dict[str, Any]:
        login_id = self.login_id

        password = self.password

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "loginId": login_id,
                "password": password,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        login_id = d.pop("loginId")

        password = d.pop("password")

        login_request = cls(
            login_id=login_id,
            password=password,
        )

        return login_request
