from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.get_developer_room_catalog_response_200 import GetDeveloperRoomCatalogResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/developer/room-catalog",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | GetDeveloperRoomCatalogResponse200 | None:
    if response.status_code == 200:
        response_200 = GetDeveloperRoomCatalogResponse200.from_dict(response.json())

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
) -> Response[ErrorEnvelope | GetDeveloperRoomCatalogResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperRoomCatalogResponse200]:
    """개발자 객실 기준정보 조회

     비밀번호 변경을 완료한 active developer 전용입니다. 객실 유형 정원과 객실 번호·유형·활성 여부·CAS version만 반환하며 예약, 점유, 청소, PIN,
    고객·메이드 정보는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperRoomCatalogResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperRoomCatalogResponse200 | None:
    """개발자 객실 기준정보 조회

     비밀번호 변경을 완료한 active developer 전용입니다. 객실 유형 정원과 객실 번호·유형·활성 여부·CAS version만 반환하며 예약, 점유, 청소, PIN,
    고객·메이드 정보는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperRoomCatalogResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperRoomCatalogResponse200]:
    """개발자 객실 기준정보 조회

     비밀번호 변경을 완료한 active developer 전용입니다. 객실 유형 정원과 객실 번호·유형·활성 여부·CAS version만 반환하며 예약, 점유, 청소, PIN,
    고객·메이드 정보는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperRoomCatalogResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperRoomCatalogResponse200 | None:
    """개발자 객실 기준정보 조회

     비밀번호 변경을 완료한 active developer 전용입니다. 객실 유형 정원과 객실 번호·유형·활성 여부·CAS version만 반환하며 예약, 점유, 청소, PIN,
    고객·메이드 정보는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperRoomCatalogResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
