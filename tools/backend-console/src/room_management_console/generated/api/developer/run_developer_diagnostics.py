from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.run_developer_diagnostics_response_200 import RunDeveloperDiagnosticsResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/developer/diagnostics",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | RunDeveloperDiagnosticsResponse200 | None:
    if response.status_code == 200:
        response_200 = RunDeveloperDiagnosticsResponse200.from_dict(response.json())

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

    if response.status_code == 429:
        response_429 = ErrorEnvelope.from_dict(response.json())

        return response_429

    if response.status_code == 500:
        response_500 = ErrorEnvelope.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | RunDeveloperDiagnosticsResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | RunDeveloperDiagnosticsResponse200]:
    """허용된 운영 진단 일괄 실행

     요청 본문·임의 URL·SQL·RPC 이름을 받지 않고 Auth/session 검증 후 runtime·DB·scheduler read-only 검사만 수행합니다. 분당 10회
    durable 제한과 개별 timeout을 적용합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | RunDeveloperDiagnosticsResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | RunDeveloperDiagnosticsResponse200 | None:
    """허용된 운영 진단 일괄 실행

     요청 본문·임의 URL·SQL·RPC 이름을 받지 않고 Auth/session 검증 후 runtime·DB·scheduler read-only 검사만 수행합니다. 분당 10회
    durable 제한과 개별 timeout을 적용합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | RunDeveloperDiagnosticsResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | RunDeveloperDiagnosticsResponse200]:
    """허용된 운영 진단 일괄 실행

     요청 본문·임의 URL·SQL·RPC 이름을 받지 않고 Auth/session 검증 후 runtime·DB·scheduler read-only 검사만 수행합니다. 분당 10회
    durable 제한과 개별 timeout을 적용합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | RunDeveloperDiagnosticsResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | RunDeveloperDiagnosticsResponse200 | None:
    """허용된 운영 진단 일괄 실행

     요청 본문·임의 URL·SQL·RPC 이름을 받지 않고 Auth/session 검증 후 runtime·DB·scheduler read-only 검사만 수행합니다. 분당 10회
    durable 제한과 개별 timeout을 적용합니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | RunDeveloperDiagnosticsResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
