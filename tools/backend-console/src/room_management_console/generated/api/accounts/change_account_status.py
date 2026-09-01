from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.change_account_status_response_200 import ChangeAccountStatusResponse200
from ...models.error_envelope import ErrorEnvelope
from ...models.status_change_request import StatusChangeRequest
from ...types import Response


def _get_kwargs(
    profile_id: UUID,
    *,
    body: StatusChangeRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/accounts/{profile_id}/status".format(
            profile_id=quote(str(profile_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ChangeAccountStatusResponse200 | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = ChangeAccountStatusResponse200.from_dict(response.json())

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
) -> Response[ChangeAccountStatusResponse200 | ErrorEnvelope]:
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
    body: StatusChangeRequest,
    idempotency_key: str,
) -> Response[ChangeAccountStatusResponse200 | ErrorEnvelope]:
    """계정 활성·비활성·퇴사 상태 변경

     developer 대상은 금지됩니다. 퇴사 처리는 먼저 inactive 상태가 되어야 하며, 마지막 active admin 비활성화는 거부됩니다. reasonCode에는 사전에
    합의된 영문 대문자 코드를 보냅니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (StatusChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ChangeAccountStatusResponse200 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        profile_id=profile_id,
        body=body,
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
    body: StatusChangeRequest,
    idempotency_key: str,
) -> ChangeAccountStatusResponse200 | ErrorEnvelope | None:
    """계정 활성·비활성·퇴사 상태 변경

     developer 대상은 금지됩니다. 퇴사 처리는 먼저 inactive 상태가 되어야 하며, 마지막 active admin 비활성화는 거부됩니다. reasonCode에는 사전에
    합의된 영문 대문자 코드를 보냅니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (StatusChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ChangeAccountStatusResponse200 | ErrorEnvelope
    """

    return sync_detailed(
        profile_id=profile_id,
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    profile_id: UUID,
    *,
    client: AuthenticatedClient,
    body: StatusChangeRequest,
    idempotency_key: str,
) -> Response[ChangeAccountStatusResponse200 | ErrorEnvelope]:
    """계정 활성·비활성·퇴사 상태 변경

     developer 대상은 금지됩니다. 퇴사 처리는 먼저 inactive 상태가 되어야 하며, 마지막 active admin 비활성화는 거부됩니다. reasonCode에는 사전에
    합의된 영문 대문자 코드를 보냅니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (StatusChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ChangeAccountStatusResponse200 | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        profile_id=profile_id,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    profile_id: UUID,
    *,
    client: AuthenticatedClient,
    body: StatusChangeRequest,
    idempotency_key: str,
) -> ChangeAccountStatusResponse200 | ErrorEnvelope | None:
    """계정 활성·비활성·퇴사 상태 변경

     developer 대상은 금지됩니다. 퇴사 처리는 먼저 inactive 상태가 되어야 하며, 마지막 active admin 비활성화는 거부됩니다. reasonCode에는 사전에
    합의된 영문 대문자 코드를 보냅니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (StatusChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ChangeAccountStatusResponse200 | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            profile_id=profile_id,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
