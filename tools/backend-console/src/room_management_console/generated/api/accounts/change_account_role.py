from http import HTTPStatus
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.change_account_role_response_200 import ChangeAccountRoleResponse200
from ...models.error_envelope import ErrorEnvelope
from ...models.role_change_request import RoleChangeRequest
from ...types import Response


def _get_kwargs(
    profile_id: UUID,
    *,
    body: RoleChangeRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/accounts/{profile_id}/role".format(
            profile_id=quote(str(profile_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ChangeAccountRoleResponse200 | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = ChangeAccountRoleResponse200.from_dict(response.json())

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
) -> Response[ChangeAccountRoleResponse200 | ErrorEnvelope]:
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
    body: RoleChangeRequest,
    idempotency_key: str,
) -> Response[ChangeAccountRoleResponse200 | ErrorEnvelope]:
    """계정의 business role 변경

     admin과 maid 사이에서만 변경할 수 있습니다. developer 대상과 developer로의 승격은 금지되며 마지막 active admin 보호를 DB가 경쟁 상황에서도
    재검증합니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (RoleChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ChangeAccountRoleResponse200 | ErrorEnvelope]
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
    body: RoleChangeRequest,
    idempotency_key: str,
) -> ChangeAccountRoleResponse200 | ErrorEnvelope | None:
    """계정의 business role 변경

     admin과 maid 사이에서만 변경할 수 있습니다. developer 대상과 developer로의 승격은 금지되며 마지막 active admin 보호를 DB가 경쟁 상황에서도
    재검증합니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (RoleChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ChangeAccountRoleResponse200 | ErrorEnvelope
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
    body: RoleChangeRequest,
    idempotency_key: str,
) -> Response[ChangeAccountRoleResponse200 | ErrorEnvelope]:
    """계정의 business role 변경

     admin과 maid 사이에서만 변경할 수 있습니다. developer 대상과 developer로의 승격은 금지되며 마지막 active admin 보호를 DB가 경쟁 상황에서도
    재검증합니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (RoleChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ChangeAccountRoleResponse200 | ErrorEnvelope]
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
    body: RoleChangeRequest,
    idempotency_key: str,
) -> ChangeAccountRoleResponse200 | ErrorEnvelope | None:
    """계정의 business role 변경

     admin과 maid 사이에서만 변경할 수 있습니다. developer 대상과 developer로의 승격은 금지되며 마지막 active admin 보호를 DB가 경쟁 상황에서도
    재검증합니다.

    Args:
        profile_id (UUID):
        idempotency_key (str):
        body (RoleChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ChangeAccountRoleResponse200 | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            profile_id=profile_id,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
