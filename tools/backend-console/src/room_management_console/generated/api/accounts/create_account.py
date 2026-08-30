from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_account_request import CreateAccountRequest
from ...models.create_account_response_201 import CreateAccountResponse201
from ...models.error_envelope import ErrorEnvelope
from ...types import Response


def _get_kwargs(
    *,
    body: CreateAccountRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/accounts",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> CreateAccountResponse201 | ErrorEnvelope | None:
    if response.status_code == 201:
        response_201 = CreateAccountResponse201.from_dict(response.json())

        return response_201

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

    if response.status_code == 502:
        response_502 = ErrorEnvelope.from_dict(response.json())

        return response_502

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[CreateAccountResponse201 | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateAccountRequest,
    idempotency_key: str,
) -> Response[CreateAccountResponse201 | ErrorEnvelope]:
    """business admin 또는 maid 계정 생성

     role은 `admin | maid`만 허용됩니다. 전체 휴대전화 번호는 중복 검사용 HMAC과 마지막 4자리로만 처리되며 응답에 원문을 돌려주지 않습니다. 생성 응답의 4자리
    임시 비밀번호는 권한 있는 생성자에게 한 번 전달하고 로그나 영속 브라우저 저장소에 보관하지 마세요.

    Args:
        idempotency_key (str):
        body (CreateAccountRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CreateAccountResponse201 | ErrorEnvelope]
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
    body: CreateAccountRequest,
    idempotency_key: str,
) -> CreateAccountResponse201 | ErrorEnvelope | None:
    """business admin 또는 maid 계정 생성

     role은 `admin | maid`만 허용됩니다. 전체 휴대전화 번호는 중복 검사용 HMAC과 마지막 4자리로만 처리되며 응답에 원문을 돌려주지 않습니다. 생성 응답의 4자리
    임시 비밀번호는 권한 있는 생성자에게 한 번 전달하고 로그나 영속 브라우저 저장소에 보관하지 마세요.

    Args:
        idempotency_key (str):
        body (CreateAccountRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CreateAccountResponse201 | ErrorEnvelope
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateAccountRequest,
    idempotency_key: str,
) -> Response[CreateAccountResponse201 | ErrorEnvelope]:
    """business admin 또는 maid 계정 생성

     role은 `admin | maid`만 허용됩니다. 전체 휴대전화 번호는 중복 검사용 HMAC과 마지막 4자리로만 처리되며 응답에 원문을 돌려주지 않습니다. 생성 응답의 4자리
    임시 비밀번호는 권한 있는 생성자에게 한 번 전달하고 로그나 영속 브라우저 저장소에 보관하지 마세요.

    Args:
        idempotency_key (str):
        body (CreateAccountRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CreateAccountResponse201 | ErrorEnvelope]
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
    body: CreateAccountRequest,
    idempotency_key: str,
) -> CreateAccountResponse201 | ErrorEnvelope | None:
    """business admin 또는 maid 계정 생성

     role은 `admin | maid`만 허용됩니다. 전체 휴대전화 번호는 중복 검사용 HMAC과 마지막 4자리로만 처리되며 응답에 원문을 돌려주지 않습니다. 생성 응답의 4자리
    임시 비밀번호는 권한 있는 생성자에게 한 번 전달하고 로그나 영속 브라우저 저장소에 보관하지 마세요.

    Args:
        idempotency_key (str):
        body (CreateAccountRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CreateAccountResponse201 | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
