from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.developer_room_type_capacity_preview_request import (
    DeveloperRoomTypeCapacityPreviewRequest,
)
from ...models.error_envelope import ErrorEnvelope
from ...models.preview_developer_room_type_capacity_response_200 import (
    PreviewDeveloperRoomTypeCapacityResponse200,
)
from ...types import Response


def _get_kwargs(
    room_type_id: UUID,
    *,
    body: DeveloperRoomTypeCapacityPreviewRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/developer/room-types/{room_type_id}/capacity/preview".format(
            room_type_id=quote(str(room_type_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200 | None:
    if response.status_code == 200:
        response_200 = PreviewDeveloperRoomTypeCapacityResponse200.from_dict(response.json())

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
) -> Response[ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200]:
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
    body: DeveloperRoomTypeCapacityPreviewRequest,
) -> Response[ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200]:
    """객실 유형 정원 변경 영향 확인

     active developer가 변경할 기준·최대 인원과 expectedVersion을 검증합니다. 현재·미래 active 예약 가운데 새 최대 인원을 초과할 건수를 PII 없이
    계산하고 5분 TTL fingerprint를 반환하며 상태는 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        body (DeveloperRoomTypeCapacityPreviewRequest): baseOccupancy는 maxOccupancy 이하여야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200]
    """

    kwargs = _get_kwargs(
        room_type_id=room_type_id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityPreviewRequest,
) -> ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200 | None:
    """객실 유형 정원 변경 영향 확인

     active developer가 변경할 기준·최대 인원과 expectedVersion을 검증합니다. 현재·미래 active 예약 가운데 새 최대 인원을 초과할 건수를 PII 없이
    계산하고 5분 TTL fingerprint를 반환하며 상태는 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        body (DeveloperRoomTypeCapacityPreviewRequest): baseOccupancy는 maxOccupancy 이하여야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200
    """

    return sync_detailed(
        room_type_id=room_type_id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityPreviewRequest,
) -> Response[ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200]:
    """객실 유형 정원 변경 영향 확인

     active developer가 변경할 기준·최대 인원과 expectedVersion을 검증합니다. 현재·미래 active 예약 가운데 새 최대 인원을 초과할 건수를 PII 없이
    계산하고 5분 TTL fingerprint를 반환하며 상태는 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        body (DeveloperRoomTypeCapacityPreviewRequest): baseOccupancy는 maxOccupancy 이하여야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200]
    """

    kwargs = _get_kwargs(
        room_type_id=room_type_id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    room_type_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomTypeCapacityPreviewRequest,
) -> ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200 | None:
    """객실 유형 정원 변경 영향 확인

     active developer가 변경할 기준·최대 인원과 expectedVersion을 검증합니다. 현재·미래 active 예약 가운데 새 최대 인원을 초과할 건수를 PII 없이
    계산하고 5분 TTL fingerprint를 반환하며 상태는 변경하지 않습니다.

    Args:
        room_type_id (UUID):
        body (DeveloperRoomTypeCapacityPreviewRequest): baseOccupancy는 maxOccupancy 이하여야 합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | PreviewDeveloperRoomTypeCapacityResponse200
    """

    return (
        await asyncio_detailed(
            room_type_id=room_type_id,
            client=client,
            body=body,
        )
    ).parsed
