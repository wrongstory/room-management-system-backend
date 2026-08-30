from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.get_current_user_response_200 import GetCurrentUserResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/auth/me",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | GetCurrentUserResponse200 | None:
    if response.status_code == 200:
        response_200 = GetCurrentUserResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = ErrorEnvelope.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = ErrorEnvelope.from_dict(response.json())

        return response_403

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | GetCurrentUserResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetCurrentUserResponse200]:
    """현재 로그인 사용자와 최신 역할 확인

     Bearer token의 Auth 사용자, 최신 active profile, 현재 active session을 모두 다시 검증합니다. 앱 시작·새로고침·세션 복구 후 이 응답을
    화면 권한의 기준으로 사용하세요.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetCurrentUserResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetCurrentUserResponse200 | None:
    """현재 로그인 사용자와 최신 역할 확인

     Bearer token의 Auth 사용자, 최신 active profile, 현재 active session을 모두 다시 검증합니다. 앱 시작·새로고침·세션 복구 후 이 응답을
    화면 권한의 기준으로 사용하세요.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetCurrentUserResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetCurrentUserResponse200]:
    """현재 로그인 사용자와 최신 역할 확인

     Bearer token의 Auth 사용자, 최신 active profile, 현재 active session을 모두 다시 검증합니다. 앱 시작·새로고침·세션 복구 후 이 응답을
    화면 권한의 기준으로 사용하세요.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetCurrentUserResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetCurrentUserResponse200 | None:
    """현재 로그인 사용자와 최신 역할 확인

     Bearer token의 Auth 사용자, 최신 active profile, 현재 active session을 모두 다시 검증합니다. 앱 시작·새로고침·세션 복구 후 이 응답을
    화면 권한의 기준으로 사용하세요.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetCurrentUserResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
