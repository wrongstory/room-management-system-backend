from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.deactivate_developer_room_response_200 import DeactivateDeveloperRoomResponse200
from ...models.developer_room_deactivation_request import DeveloperRoomDeactivationRequest
from ...models.error_envelope import ErrorEnvelope
from ...types import Response


def _get_kwargs(
    room_id: UUID,
    *,
    body: DeveloperRoomDeactivationRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/developer/rooms/{room_id}/deactivate".format(
            room_id=quote(str(room_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> DeactivateDeveloperRoomResponse200 | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = DeactivateDeveloperRoomResponse200.from_dict(response.json())

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
) -> Response[DeactivateDeveloperRoomResponse200 | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationRequest,
    idempotency_key: str,
) -> Response[DeactivateDeveloperRoomResponse200 | ErrorEnvelope]:
    """객실 안전 비활성화

     active developer가 preview fingerprint와 expectedVersion을 Idempotency-Key로 확정합니다. blocker가 있으면 409이며
    성공 시 hard delete 없이 inactive로 전환해 기존 예약·청소·PIN·감사 참조를 보존합니다.

    Args:
        room_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomDeactivationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeactivateDeveloperRoomResponse200 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        room_id=room_id,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationRequest,
    idempotency_key: str,
) -> DeactivateDeveloperRoomResponse200 | ErrorEnvelope | None:
    """객실 안전 비활성화

     active developer가 preview fingerprint와 expectedVersion을 Idempotency-Key로 확정합니다. blocker가 있으면 409이며
    성공 시 hard delete 없이 inactive로 전환해 기존 예약·청소·PIN·감사 참조를 보존합니다.

    Args:
        room_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomDeactivationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeactivateDeveloperRoomResponse200 | ErrorEnvelope
    """

    return sync_detailed(
        room_id=room_id,
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationRequest,
    idempotency_key: str,
) -> Response[DeactivateDeveloperRoomResponse200 | ErrorEnvelope]:
    """객실 안전 비활성화

     active developer가 preview fingerprint와 expectedVersion을 Idempotency-Key로 확정합니다. blocker가 있으면 409이며
    성공 시 hard delete 없이 inactive로 전환해 기존 예약·청소·PIN·감사 참조를 보존합니다.

    Args:
        room_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomDeactivationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeactivateDeveloperRoomResponse200 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        room_id=room_id,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationRequest,
    idempotency_key: str,
) -> DeactivateDeveloperRoomResponse200 | ErrorEnvelope | None:
    """객실 안전 비활성화

     active developer가 preview fingerprint와 expectedVersion을 Idempotency-Key로 확정합니다. blocker가 있으면 409이며
    성공 시 hard delete 없이 inactive로 전환해 기존 예약·청소·PIN·감사 참조를 보존합니다.

    Args:
        room_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomDeactivationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeactivateDeveloperRoomResponse200 | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            room_id=room_id,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
