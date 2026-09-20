from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_developer_room_request import CreateDeveloperRoomRequest
from ...models.create_developer_room_response_201 import CreateDeveloperRoomResponse201
from ...models.error_envelope import ErrorEnvelope
from ...types import Response


def _get_kwargs(
    *,
    body: CreateDeveloperRoomRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/developer/rooms",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> CreateDeveloperRoomResponse201 | ErrorEnvelope | None:
    if response.status_code == 201:
        response_201 = CreateDeveloperRoomResponse201.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = ErrorEnvelope.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorEnvelope.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = ErrorEnvelope.from_dict(response.json())

        return response_403

    if response.status_code == 409:
        response_409 = ErrorEnvelope.from_dict(response.json())

        return response_409

    if response.status_code == 500:
        response_500 = ErrorEnvelope.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateDeveloperRoomRequest,
    idempotency_key: str,
) -> Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]:
    """개발자 객실 추가

     published room type의 version을 CAS 검증하고 active 500실 상한 안에서 새 immutable room ID를 생성합니다. 과거에 사용한
    roomNumber는 재사용하지 않습니다.

    Args:
        idempotency_key (str):
        body (CreateDeveloperRoomRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    body: CreateDeveloperRoomRequest,
    idempotency_key: str,
) -> CreateDeveloperRoomResponse201 | ErrorEnvelope | None:
    """개발자 객실 추가

     published room type의 version을 CAS 검증하고 active 500실 상한 안에서 새 immutable room ID를 생성합니다. 과거에 사용한
    roomNumber는 재사용하지 않습니다.

    Args:
        idempotency_key (str):
        body (CreateDeveloperRoomRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CreateDeveloperRoomResponse201 | ErrorEnvelope
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateDeveloperRoomRequest,
    idempotency_key: str,
) -> Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]:
    """개발자 객실 추가

     published room type의 version을 CAS 검증하고 active 500실 상한 안에서 새 immutable room ID를 생성합니다. 과거에 사용한
    roomNumber는 재사용하지 않습니다.

    Args:
        idempotency_key (str):
        body (CreateDeveloperRoomRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: CreateDeveloperRoomRequest,
    idempotency_key: str,
) -> CreateDeveloperRoomResponse201 | ErrorEnvelope | None:
    """개발자 객실 추가

     published room type의 version을 CAS 검증하고 active 500실 상한 안에서 새 immutable room ID를 생성합니다. 과거에 사용한
    roomNumber는 재사용하지 않습니다.

    Args:
        idempotency_key (str):
        body (CreateDeveloperRoomRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CreateDeveloperRoomResponse201 | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
