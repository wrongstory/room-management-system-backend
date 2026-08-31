from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.actor import Actor


T = TypeVar("T", bound="LoginResponse")


@_attrs_define
class LoginResponse:
    """
    Attributes:
        access_token (str): 보호 API의 Bearer token. 로그·Issue·캡처에 남기지 않습니다.
        refresh_token (str): Supabase Auth 표준 세션 갱신용 토큰. 서버 API 요청 본문에 보내지 않습니다.
        expires_in (int): access token 만료까지 남은 초
        user (Actor):
    """

    access_token: str
    refresh_token: str
    expires_in: int
    user: Actor
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        access_token = self.access_token

        refresh_token = self.refresh_token

        expires_in = self.expires_in

        user = self.user.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresIn": expires_in,
                "user": user,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.actor import Actor

        d = dict(src_dict)
        access_token = d.pop("accessToken")

        refresh_token = d.pop("refreshToken")

        expires_in = d.pop("expiresIn")

        user = Actor.from_dict(d.pop("user"))

        login_response = cls(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=expires_in,
            user=user,
        )

        login_response.additional_properties = d
        return login_response

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
