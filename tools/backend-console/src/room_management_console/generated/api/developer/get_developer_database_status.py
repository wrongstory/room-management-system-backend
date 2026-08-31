from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.get_developer_database_status_response_200 import (
    GetDeveloperDatabaseStatusResponse200,
)
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/developer/database-status",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | GetDeveloperDatabaseStatusResponse200 | None:
    if response.status_code == 200:
        response_200 = GetDeveloperDatabaseStatusResponse200.from_dict(response.json())

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
) -> Response[ErrorEnvelope | GetDeveloperDatabaseStatusResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperDatabaseStatusResponse200]:
    """DB migration·RLS·핵심 RPC 상태 조회

     source가 기대하는 migration head와 실제 DB head를 비교하고 public base table RLS 누락과 허용된 핵심 RPC 존재 여부만 반환합니다.
    auth·vault·migration 원본 row는 반환하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperDatabaseStatusResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperDatabaseStatusResponse200 | None:
    """DB migration·RLS·핵심 RPC 상태 조회

     source가 기대하는 migration head와 실제 DB head를 비교하고 public base table RLS 누락과 허용된 핵심 RPC 존재 여부만 반환합니다.
    auth·vault·migration 원본 row는 반환하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperDatabaseStatusResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperDatabaseStatusResponse200]:
    """DB migration·RLS·핵심 RPC 상태 조회

     source가 기대하는 migration head와 실제 DB head를 비교하고 public base table RLS 누락과 허용된 핵심 RPC 존재 여부만 반환합니다.
    auth·vault·migration 원본 row는 반환하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperDatabaseStatusResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperDatabaseStatusResponse200 | None:
    """DB migration·RLS·핵심 RPC 상태 조회

     source가 기대하는 migration head와 실제 DB head를 비교하고 public base table RLS 누락과 허용된 핵심 RPC 존재 여부만 반환합니다.
    auth·vault·migration 원본 row는 반환하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperDatabaseStatusResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
