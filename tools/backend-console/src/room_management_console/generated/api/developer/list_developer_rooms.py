from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.developer_room_catalog_page import DeveloperRoomCatalogPage
from ...models.error_envelope import ErrorEnvelope
from ...models.list_developer_rooms_status import ListDeveloperRoomsStatus
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    status: ListDeveloperRoomsStatus | Unset = ListDeveloperRoomsStatus.ALL,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_status: str | Unset = UNSET
    if not isinstance(status, Unset):
        json_status = status.value

    params["status"] = json_status

    params["cursor"] = cursor

    params["limit"] = limit

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/developer/rooms",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> DeveloperRoomCatalogPage | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = DeveloperRoomCatalogPage.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ErrorEnvelope.from_dict(response.json())

        return response_400

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
) -> Response[DeveloperRoomCatalogPage | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    status: ListDeveloperRoomsStatus | Unset = ListDeveloperRoomsStatus.ALL,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> Response[DeveloperRoomCatalogPage | ErrorEnvelope]:
    """개발자 객실 카탈로그 조회

     active developer 전용 bounded cursor 목록입니다. 활성·은퇴·전체 수와 이력을 보존한 객실 기준정보를 반환합니다.

    Args:
        status (ListDeveloperRoomsStatus | Unset):  Default: ListDeveloperRoomsStatus.ALL.
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeveloperRoomCatalogPage | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        status=status,
        cursor=cursor,
        limit=limit,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    status: ListDeveloperRoomsStatus | Unset = ListDeveloperRoomsStatus.ALL,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> DeveloperRoomCatalogPage | ErrorEnvelope | None:
    """개발자 객실 카탈로그 조회

     active developer 전용 bounded cursor 목록입니다. 활성·은퇴·전체 수와 이력을 보존한 객실 기준정보를 반환합니다.

    Args:
        status (ListDeveloperRoomsStatus | Unset):  Default: ListDeveloperRoomsStatus.ALL.
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeveloperRoomCatalogPage | ErrorEnvelope
    """

    return sync_detailed(
        client=client,
        status=status,
        cursor=cursor,
        limit=limit,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    status: ListDeveloperRoomsStatus | Unset = ListDeveloperRoomsStatus.ALL,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> Response[DeveloperRoomCatalogPage | ErrorEnvelope]:
    """개발자 객실 카탈로그 조회

     active developer 전용 bounded cursor 목록입니다. 활성·은퇴·전체 수와 이력을 보존한 객실 기준정보를 반환합니다.

    Args:
        status (ListDeveloperRoomsStatus | Unset):  Default: ListDeveloperRoomsStatus.ALL.
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeveloperRoomCatalogPage | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        status=status,
        cursor=cursor,
        limit=limit,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    status: ListDeveloperRoomsStatus | Unset = ListDeveloperRoomsStatus.ALL,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> DeveloperRoomCatalogPage | ErrorEnvelope | None:
    """개발자 객실 카탈로그 조회

     active developer 전용 bounded cursor 목록입니다. 활성·은퇴·전체 수와 이력을 보존한 객실 기준정보를 반환합니다.

    Args:
        status (ListDeveloperRoomsStatus | Unset):  Default: ListDeveloperRoomsStatus.ALL.
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeveloperRoomCatalogPage | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            status=status,
            cursor=cursor,
            limit=limit,
        )
    ).parsed
