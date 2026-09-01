from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.unlock_account_response_200 import UnlockAccountResponse200
from ...types import Response


def _get_kwargs(
    profile_id: UUID,
    *,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/accounts/{profile_id}/unlock".format(
            profile_id=quote(str(profile_id), safe=""),
        ),
    }

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | UnlockAccountResponse200 | None:
    if response.status_code == 200:
        response_200 = UnlockAccountResponse200.from_dict(response.json())

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

    if response.status_code == 502:
        response_502 = ErrorEnvelope.from_dict(response.json())

        return response_502

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | UnlockAccountResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    profile_id: UUID,
    *,
    client: AuthenticatedClient,
    idempotency_key: str,
) -> Response[ErrorEnvelope | UnlockAccountResponse200]:
    """계정 로그인 잠금 해제

     5회 로그인 실패로 잠긴 admin 또는 maid 계정의 실패 횟수와 잠금을 해제합니다. developer 대상은 일반 계정 명령으로 처리할 수 없습니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | UnlockAccountResponse200]
    """

    kwargs = _get_kwargs(
        profile_id=profile_id,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    profile_id: UUID,
    *,
    client: AuthenticatedClient,
    idempotency_key: str,
) -> ErrorEnvelope | UnlockAccountResponse200 | None:
    """계정 로그인 잠금 해제

     5회 로그인 실패로 잠긴 admin 또는 maid 계정의 실패 횟수와 잠금을 해제합니다. developer 대상은 일반 계정 명령으로 처리할 수 없습니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | UnlockAccountResponse200
    """

    return sync_detailed(
        profile_id=profile_id,
        client=client,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    profile_id: UUID,
    *,
    client: AuthenticatedClient,
    idempotency_key: str,
) -> Response[ErrorEnvelope | UnlockAccountResponse200]:
    """계정 로그인 잠금 해제

     5회 로그인 실패로 잠긴 admin 또는 maid 계정의 실패 횟수와 잠금을 해제합니다. developer 대상은 일반 계정 명령으로 처리할 수 없습니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | UnlockAccountResponse200]
    """

    kwargs = _get_kwargs(
        profile_id=profile_id,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    profile_id: UUID,
    *,
    client: AuthenticatedClient,
    idempotency_key: str,
) -> ErrorEnvelope | UnlockAccountResponse200 | None:
    """계정 로그인 잠금 해제

     5회 로그인 실패로 잠긴 admin 또는 maid 계정의 실패 횟수와 잠금을 해제합니다. developer 대상은 일반 계정 명령으로 처리할 수 없습니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | UnlockAccountResponse200
    """

    return (
        await asyncio_detailed(
            profile_id=profile_id,
            client=client,
            idempotency_key=idempotency_key,
        )
    ).parsed
