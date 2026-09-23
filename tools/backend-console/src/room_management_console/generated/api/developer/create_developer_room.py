from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_developer_room_response_201 import CreateDeveloperRoomResponse201
from ...models.developer_room_create_request import DeveloperRoomCreateRequest
from ...models.error_envelope import ErrorEnvelope
from ...types import Response


def _get_kwargs(
    *,
    body: DeveloperRoomCreateRequest,
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

    if response.status_code == 404:
        response_404 = ErrorEnvelope.from_dict(response.json())

        return response_404

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
    body: DeveloperRoomCreateRequest,
    idempotency_key: str,
) -> Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]:
    """객실 기준정보 추가

     active developer가 숫자 문자열 객실 번호와 active 객실 유형을 지정해 객실을 추가합니다. 객실 유형 version을 CAS로 확인하고 새 객실은 운영 준비
    확인이 필요한 verification_required 상태로 시작합니다.

    Args:
        idempotency_key (str):
        body (DeveloperRoomCreateRequest):

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
    body: DeveloperRoomCreateRequest,
    idempotency_key: str,
) -> CreateDeveloperRoomResponse201 | ErrorEnvelope | None:
    """객실 기준정보 추가

     active developer가 숫자 문자열 객실 번호와 active 객실 유형을 지정해 객실을 추가합니다. 객실 유형 version을 CAS로 확인하고 새 객실은 운영 준비
    확인이 필요한 verification_required 상태로 시작합니다.

    Args:
        idempotency_key (str):
        body (DeveloperRoomCreateRequest):

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
    body: DeveloperRoomCreateRequest,
    idempotency_key: str,
) -> Response[CreateDeveloperRoomResponse201 | ErrorEnvelope]:
    """객실 기준정보 추가

     active developer가 숫자 문자열 객실 번호와 active 객실 유형을 지정해 객실을 추가합니다. 객실 유형 version을 CAS로 확인하고 새 객실은 운영 준비
    확인이 필요한 verification_required 상태로 시작합니다.

    Args:
        idempotency_key (str):
        body (DeveloperRoomCreateRequest):

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
    body: DeveloperRoomCreateRequest,
    idempotency_key: str,
) -> CreateDeveloperRoomResponse201 | ErrorEnvelope | None:
    """객실 기준정보 추가

     active developer가 숫자 문자열 객실 번호와 active 객실 유형을 지정해 객실을 추가합니다. 객실 유형 version을 CAS로 확인하고 새 객실은 운영 준비
    확인이 필요한 verification_required 상태로 시작합니다.

    Args:
        idempotency_key (str):
        body (DeveloperRoomCreateRequest):

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
