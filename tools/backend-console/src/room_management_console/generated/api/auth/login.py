from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.login_request import LoginRequest
from ...models.login_response import LoginResponse
from ...types import Response


def _get_kwargs(
    *,
    body: LoginRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/auth/login",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | LoginResponse | None:
    if response.status_code == 200:
        response_200 = LoginResponse.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ErrorEnvelope.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorEnvelope.from_dict(response.json())

        return response_401

    if response.status_code == 423:
        response_423 = ErrorEnvelope.from_dict(response.json())

        return response_423

    if response.status_code == 429:
        response_429 = ErrorEnvelope.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | LoginResponse]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: LoginRequest,
) -> Response[ErrorEnvelope | LoginResponse]:
    """로그인하고 세션 토큰 받기

     로그인 ID는 NFKC·trim·소문자로 정규화됩니다. 알 수 없는 ID와 잘못된 비밀번호는 모두 `INVALID_CREDENTIALS`입니다. Supabase gateway가
    확인한 client별 30회/분, ID별 10회/분, 프로젝트 emergency 600회/분 durable 제한을 순서대로 적용하고 계정별 5회 실패/15분 잠금도 유지합니다.
    응답의 `mustChangePassword`가 true이면 비밀번호 변경 화면으로 이동하세요.

    Args:
        body (LoginRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | LoginResponse]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: LoginRequest,
) -> ErrorEnvelope | LoginResponse | None:
    """로그인하고 세션 토큰 받기

     로그인 ID는 NFKC·trim·소문자로 정규화됩니다. 알 수 없는 ID와 잘못된 비밀번호는 모두 `INVALID_CREDENTIALS`입니다. Supabase gateway가
    확인한 client별 30회/분, ID별 10회/분, 프로젝트 emergency 600회/분 durable 제한을 순서대로 적용하고 계정별 5회 실패/15분 잠금도 유지합니다.
    응답의 `mustChangePassword`가 true이면 비밀번호 변경 화면으로 이동하세요.

    Args:
        body (LoginRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | LoginResponse
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: LoginRequest,
) -> Response[ErrorEnvelope | LoginResponse]:
    """로그인하고 세션 토큰 받기

     로그인 ID는 NFKC·trim·소문자로 정규화됩니다. 알 수 없는 ID와 잘못된 비밀번호는 모두 `INVALID_CREDENTIALS`입니다. Supabase gateway가
    확인한 client별 30회/분, ID별 10회/분, 프로젝트 emergency 600회/분 durable 제한을 순서대로 적용하고 계정별 5회 실패/15분 잠금도 유지합니다.
    응답의 `mustChangePassword`가 true이면 비밀번호 변경 화면으로 이동하세요.

    Args:
        body (LoginRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | LoginResponse]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: LoginRequest,
) -> ErrorEnvelope | LoginResponse | None:
    """로그인하고 세션 토큰 받기

     로그인 ID는 NFKC·trim·소문자로 정규화됩니다. 알 수 없는 ID와 잘못된 비밀번호는 모두 `INVALID_CREDENTIALS`입니다. Supabase gateway가
    확인한 client별 30회/분, ID별 10회/분, 프로젝트 emergency 600회/분 durable 제한을 순서대로 적용하고 계정별 5회 실패/15분 잠금도 유지합니다.
    응답의 `mustChangePassword`가 true이면 비밀번호 변경 화면으로 이동하세요.

    Args:
        body (LoginRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | LoginResponse
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
