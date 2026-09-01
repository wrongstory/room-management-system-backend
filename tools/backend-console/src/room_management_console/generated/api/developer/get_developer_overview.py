from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.get_developer_overview_response_200 import GetDeveloperOverviewResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/developer/overview",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | GetDeveloperOverviewResponse200 | None:
    if response.status_code == 200:
        response_200 = GetDeveloperOverviewResponse200.from_dict(response.json())

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
) -> Response[ErrorEnvelope | GetDeveloperOverviewResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperOverviewResponse200]:
    """개발자 운영 대시보드 요약 조회

     active developer 전용입니다. 계정·객실 집계와 runtime·DB·scheduler의 app-owned projection을 한 번에 반환합니다. 전체 전화번호,
    고객명, secret 값, 내부 catalog row는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperOverviewResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperOverviewResponse200 | None:
    """개발자 운영 대시보드 요약 조회

     active developer 전용입니다. 계정·객실 집계와 runtime·DB·scheduler의 app-owned projection을 한 번에 반환합니다. 전체 전화번호,
    고객명, secret 값, 내부 catalog row는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperOverviewResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ErrorEnvelope | GetDeveloperOverviewResponse200]:
    """개발자 운영 대시보드 요약 조회

     active developer 전용입니다. 계정·객실 집계와 runtime·DB·scheduler의 app-owned projection을 한 번에 반환합니다. 전체 전화번호,
    고객명, secret 값, 내부 catalog row는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | GetDeveloperOverviewResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ErrorEnvelope | GetDeveloperOverviewResponse200 | None:
    """개발자 운영 대시보드 요약 조회

     active developer 전용입니다. 계정·객실 집계와 runtime·DB·scheduler의 app-owned projection을 한 번에 반환합니다. 전체 전화번호,
    고객명, secret 값, 내부 catalog row는 포함하지 않습니다.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | GetDeveloperOverviewResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
