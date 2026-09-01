from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.get_developer_runtime_status_response_200 import GetDeveloperRuntimeStatusResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/developer/runtime-status",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | GetDeveloperRuntimeStatusResponse200 | None:
    if response.status_code == 200:
        response_200 = GetDeveloperRuntimeStatusResponse200.from_dict(response.json())

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
) -> Response[ErrorEnvelope | GetDeveloperRuntimeStatusResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperRuntimeStatusResponse200]:
    """Edge runtime과 설정 여부 조회

     환경 badge, project ref, adapter와 allowlist 설정의 configured 여부만 반환합니다. 환경변수를 열거하거나 secret 값·길이·해시를 노출하지
    않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperRuntimeStatusResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperRuntimeStatusResponse200 | None:
    """Edge runtime과 설정 여부 조회

     환경 badge, project ref, adapter와 allowlist 설정의 configured 여부만 반환합니다. 환경변수를 열거하거나 secret 값·길이·해시를 노출하지
    않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperRuntimeStatusResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperRuntimeStatusResponse200]:
    """Edge runtime과 설정 여부 조회

     환경 badge, project ref, adapter와 allowlist 설정의 configured 여부만 반환합니다. 환경변수를 열거하거나 secret 값·길이·해시를 노출하지
    않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperRuntimeStatusResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperRuntimeStatusResponse200 | None:
    """Edge runtime과 설정 여부 조회

     환경 badge, project ref, adapter와 allowlist 설정의 configured 여부만 반환합니다. 환경변수를 열거하거나 secret 값·길이·해시를 노출하지
    않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperRuntimeStatusResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
