from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.developer_room_deactivation_preview_request import (
    DeveloperRoomDeactivationPreviewRequest,
)
from ...models.error_envelope import ErrorEnvelope
from ...models.preview_developer_room_deactivation_response_200 import (
    PreviewDeveloperRoomDeactivationResponse200,
)
from ...types import Response


def _get_kwargs(
    room_id: UUID,
    *,
    body: DeveloperRoomDeactivationPreviewRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/developer/rooms/{room_id}/deactivation/preview".format(
            room_id=quote(str(room_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200 | None:
    if response.status_code == 200:
        response_200 = PreviewDeveloperRoomDeactivationResponse200.from_dict(response.json())

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
) -> Response[ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200]:
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
    body: DeveloperRoomDeactivationPreviewRequest,
) -> Response[ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200]:
    """객실 비활성화 영향 확인

     active developer가 객실 version을 CAS로 확인하고 현재 점유, active·future 예약, 진행 중 청소, PIN 변경 lease, 미해결 운영 건수를
    PII 없이 조회합니다. 5분 TTL fingerprint만 만들며 이력이나 상태는 변경하지 않습니다.

    Args:
        room_id (UUID):
        body (DeveloperRoomDeactivationPreviewRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200]
    """

    kwargs = _get_kwargs(
        room_id=room_id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationPreviewRequest,
) -> ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200 | None:
    """객실 비활성화 영향 확인

     active developer가 객실 version을 CAS로 확인하고 현재 점유, active·future 예약, 진행 중 청소, PIN 변경 lease, 미해결 운영 건수를
    PII 없이 조회합니다. 5분 TTL fingerprint만 만들며 이력이나 상태는 변경하지 않습니다.

    Args:
        room_id (UUID):
        body (DeveloperRoomDeactivationPreviewRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200
    """

    return sync_detailed(
        room_id=room_id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationPreviewRequest,
) -> Response[ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200]:
    """객실 비활성화 영향 확인

     active developer가 객실 version을 CAS로 확인하고 현재 점유, active·future 예약, 진행 중 청소, PIN 변경 lease, 미해결 운영 건수를
    PII 없이 조회합니다. 5분 TTL fingerprint만 만들며 이력이나 상태는 변경하지 않습니다.

    Args:
        room_id (UUID):
        body (DeveloperRoomDeactivationPreviewRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200]
    """

    kwargs = _get_kwargs(
        room_id=room_id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    room_id: UUID,
    *,
    client: AuthenticatedClient,
    body: DeveloperRoomDeactivationPreviewRequest,
) -> ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200 | None:
    """객실 비활성화 영향 확인

     active developer가 객실 version을 CAS로 확인하고 현재 점유, active·future 예약, 진행 중 청소, PIN 변경 lease, 미해결 운영 건수를
    PII 없이 조회합니다. 5분 TTL fingerprint만 만들며 이력이나 상태는 변경하지 않습니다.

    Args:
        room_id (UUID):
        body (DeveloperRoomDeactivationPreviewRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | PreviewDeveloperRoomDeactivationResponse200
    """

    return (
        await asyncio_detailed(
            room_id=room_id,
            client=client,
            body=body,
        )
    ).parsed
