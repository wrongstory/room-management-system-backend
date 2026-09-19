from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.room_type_catalog_envelope import RoomTypeCatalogEnvelope
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/room-types",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | RoomTypeCatalogEnvelope | None:
    if response.status_code == 200:
        response_200 = RoomTypeCatalogEnvelope.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = ErrorEnvelope.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = ErrorEnvelope.from_dict(response.json())

        return response_403

    if response.status_code == 500:
        response_500 = ErrorEnvelope.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | RoomTypeCatalogEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | RoomTypeCatalogEnvelope]:
    """객실 타입 카탈로그 조회

     비밀번호 변경을 완료한 active business admin 전용입니다. 비활성 타입도 기존 객실 참조 현황을 위해 포함하지만 신규 객실 기준정보 선택에는 사용할 수 없습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | RoomTypeCatalogEnvelope]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | RoomTypeCatalogEnvelope | None:
    """객실 타입 카탈로그 조회

     비밀번호 변경을 완료한 active business admin 전용입니다. 비활성 타입도 기존 객실 참조 현황을 위해 포함하지만 신규 객실 기준정보 선택에는 사용할 수 없습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | RoomTypeCatalogEnvelope
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | RoomTypeCatalogEnvelope]:
    """객실 타입 카탈로그 조회

     비밀번호 변경을 완료한 active business admin 전용입니다. 비활성 타입도 기존 객실 참조 현황을 위해 포함하지만 신규 객실 기준정보 선택에는 사용할 수 없습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | RoomTypeCatalogEnvelope]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | RoomTypeCatalogEnvelope | None:
    """객실 타입 카탈로그 조회

     비밀번호 변경을 완료한 active business admin 전용입니다. 비활성 타입도 기존 객실 참조 현황을 위해 포함하지만 신규 객실 기준정보 선택에는 사용할 수 없습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | RoomTypeCatalogEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
