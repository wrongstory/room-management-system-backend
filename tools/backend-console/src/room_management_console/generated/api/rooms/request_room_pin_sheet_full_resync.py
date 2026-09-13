from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.request_room_pin_sheet_full_resync_response_202 import (
    RequestRoomPinSheetFullResyncResponse202,
)
from ...models.room_pin_sheet_full_resync_request import RoomPinSheetFullResyncRequest
from ...types import Response


def _get_kwargs(
    *,
    body: RoomPinSheetFullResyncRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/room-pin-sheet-sync/full-resync",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202 | None:
    if response.status_code == 202:
        response_202 = RequestRoomPinSheetFullResyncResponse202.from_dict(response.json())

        return response_202

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

    if response.status_code == 503:
        response_503 = ErrorEnvelope.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: RoomPinSheetFullResyncRequest,
    idempotency_key: str,
) -> Response[ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202]:
    """PIN Sheet 121실 전체 복구 요청

     Supabase 121실 정본 snapshot으로 삭제·정렬·변조된 Sheet 행을 deterministic A2:H122 범위에 복구하는 server-owned
    command입니다. source-approved exact target identity와 singleton fence를 검증하고 Sheet 값을 DB로 읽어들이지 않습니다.

    Args:
        idempotency_key (str):
        body (RoomPinSheetFullResyncRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202]
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
    body: RoomPinSheetFullResyncRequest,
    idempotency_key: str,
) -> ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202 | None:
    """PIN Sheet 121실 전체 복구 요청

     Supabase 121실 정본 snapshot으로 삭제·정렬·변조된 Sheet 행을 deterministic A2:H122 범위에 복구하는 server-owned
    command입니다. source-approved exact target identity와 singleton fence를 검증하고 Sheet 값을 DB로 읽어들이지 않습니다.

    Args:
        idempotency_key (str):
        body (RoomPinSheetFullResyncRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: RoomPinSheetFullResyncRequest,
    idempotency_key: str,
) -> Response[ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202]:
    """PIN Sheet 121실 전체 복구 요청

     Supabase 121실 정본 snapshot으로 삭제·정렬·변조된 Sheet 행을 deterministic A2:H122 범위에 복구하는 server-owned
    command입니다. source-approved exact target identity와 singleton fence를 검증하고 Sheet 값을 DB로 읽어들이지 않습니다.

    Args:
        idempotency_key (str):
        body (RoomPinSheetFullResyncRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202]
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
    body: RoomPinSheetFullResyncRequest,
    idempotency_key: str,
) -> ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202 | None:
    """PIN Sheet 121실 전체 복구 요청

     Supabase 121실 정본 snapshot으로 삭제·정렬·변조된 Sheet 행을 deterministic A2:H122 범위에 복구하는 server-owned
    command입니다. source-approved exact target identity와 singleton fence를 검증하고 Sheet 값을 DB로 읽어들이지 않습니다.

    Args:
        idempotency_key (str):
        body (RoomPinSheetFullResyncRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | RequestRoomPinSheetFullResyncResponse202
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
