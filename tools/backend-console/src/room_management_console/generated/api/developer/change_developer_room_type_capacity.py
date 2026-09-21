from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.change_developer_room_type_capacity_response_200 import (
    ChangeDeveloperRoomTypeCapacityResponse200,
)
from ...models.developer_room_type_capacity_change_request import (
    DeveloperRoomTypeCapacityChangeRequest,
)
from ...models.error_envelope import ErrorEnvelope
from ...types import Response


def _get_kwargs(
    room_type_id: UUID,
    *,
    body: DeveloperRoomTypeCapacityChangeRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/developer/room-types/{room_type_id}/capacity".format(
            room_type_id=quote(str(room_type_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = ChangeDeveloperRoomTypeCapacityResponse200.from_dict(response.json())

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
) -> Response[ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityChangeRequest,
    idempotency_key: str,
) -> Response[ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope]:
    """객실 유형 정원 변경 확정

     active developer가 preview와 동일한 값·version·영향 fingerprint를 Idempotency-Key와 함께 확정합니다. 초과 active 예약이
    있거나 영향이 변하면 409이며 기존 예약 인원은 소급 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomTypeCapacityChangeRequest): baseOccupancy는 maxOccupancy 이하여야 하며
            preview와 모든 값이 같아야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        room_type_id=room_type_id,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityChangeRequest,
    idempotency_key: str,
) -> ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope | None:
    """객실 유형 정원 변경 확정

     active developer가 preview와 동일한 값·version·영향 fingerprint를 Idempotency-Key와 함께 확정합니다. 초과 active 예약이
    있거나 영향이 변하면 409이며 기존 예약 인원은 소급 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomTypeCapacityChangeRequest): baseOccupancy는 maxOccupancy 이하여야 하며
            preview와 모든 값이 같아야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope
    """

    return sync_detailed(
        room_type_id=room_type_id,
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityChangeRequest,
    idempotency_key: str,
) -> Response[ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope]:
    """객실 유형 정원 변경 확정

     active developer가 preview와 동일한 값·version·영향 fingerprint를 Idempotency-Key와 함께 확정합니다. 초과 active 예약이
    있거나 영향이 변하면 409이며 기존 예약 인원은 소급 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomTypeCapacityChangeRequest): baseOccupancy는 maxOccupancy 이하여야 하며
            preview와 모든 값이 같아야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        room_type_id=room_type_id,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityChangeRequest,
    idempotency_key: str,
) -> ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope | None:
    """객실 유형 정원 변경 확정

     active developer가 preview와 동일한 값·version·영향 fingerprint를 Idempotency-Key와 함께 확정합니다. 초과 active 예약이
    있거나 영향이 변하면 409이며 기존 예약 인원은 소급 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        idempotency_key (str):
        body (DeveloperRoomTypeCapacityChangeRequest): baseOccupancy는 maxOccupancy 이하여야 하며
            preview와 모든 값이 같아야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ChangeDeveloperRoomTypeCapacityResponse200 | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            room_type_id=room_type_id,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
