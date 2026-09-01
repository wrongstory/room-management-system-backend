import datetime
from http import HTTPStatus
from typing import Any
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.developer_audit_event_type import DeveloperAuditEventType
from ...models.developer_audit_page import DeveloperAuditPage
from ...models.error_envelope import ErrorEnvelope
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    event_type: list[DeveloperAuditEventType] | Unset = UNSET,
    actor_profile_id: UUID | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_event_type: list[str] | Unset = UNSET
    if not isinstance(event_type, Unset):
        json_event_type = []
        for event_type_item_data in event_type:
            event_type_item = event_type_item_data.value
            json_event_type.append(event_type_item)

    params["eventType"] = json_event_type

    json_actor_profile_id: str | Unset = UNSET
    if not isinstance(actor_profile_id, Unset):
        json_actor_profile_id = str(actor_profile_id)
    params["actorProfileId"] = json_actor_profile_id

    json_from_: str | Unset = UNSET
    if not isinstance(from_, Unset):
        json_from_ = from_.isoformat()
    params["from"] = json_from_

    json_to: str | Unset = UNSET
    if not isinstance(to, Unset):
        json_to = to.isoformat()
    params["to"] = json_to

    params["cursor"] = cursor

    params["limit"] = limit

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/developer/audit-events",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> DeveloperAuditPage | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = DeveloperAuditPage.from_dict(response.json())

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

    if response.status_code == 500:
        response_500 = ErrorEnvelope.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[DeveloperAuditPage | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    event_type: list[DeveloperAuditEventType] | Unset = UNSET,
    actor_profile_id: UUID | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> Response[DeveloperAuditPage | ErrorEnvelope]:
    """허용된 운영 감사 이벤트 조회

     계정·운영 event allowlist만 최대 31일, 페이지당 100건으로 조회합니다. cursor는 응답 값을 그대로 사용하고 raw
    before_state/after_state 대신 이벤트별 허용 필드 summary만 표시합니다.

    Args:
        event_type (list[DeveloperAuditEventType] | Unset):
        actor_profile_id (UUID | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeveloperAuditPage | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        event_type=event_type,
        actor_profile_id=actor_profile_id,
        from_=from_,
        to=to,
        cursor=cursor,
        limit=limit,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    event_type: list[DeveloperAuditEventType] | Unset = UNSET,
    actor_profile_id: UUID | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> DeveloperAuditPage | ErrorEnvelope | None:
    """허용된 운영 감사 이벤트 조회

     계정·운영 event allowlist만 최대 31일, 페이지당 100건으로 조회합니다. cursor는 응답 값을 그대로 사용하고 raw
    before_state/after_state 대신 이벤트별 허용 필드 summary만 표시합니다.

    Args:
        event_type (list[DeveloperAuditEventType] | Unset):
        actor_profile_id (UUID | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeveloperAuditPage | ErrorEnvelope
    """

    return sync_detailed(
        client=client,
        event_type=event_type,
        actor_profile_id=actor_profile_id,
        from_=from_,
        to=to,
        cursor=cursor,
        limit=limit,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    event_type: list[DeveloperAuditEventType] | Unset = UNSET,
    actor_profile_id: UUID | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> Response[DeveloperAuditPage | ErrorEnvelope]:
    """허용된 운영 감사 이벤트 조회

     계정·운영 event allowlist만 최대 31일, 페이지당 100건으로 조회합니다. cursor는 응답 값을 그대로 사용하고 raw
    before_state/after_state 대신 이벤트별 허용 필드 summary만 표시합니다.

    Args:
        event_type (list[DeveloperAuditEventType] | Unset):
        actor_profile_id (UUID | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeveloperAuditPage | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        event_type=event_type,
        actor_profile_id=actor_profile_id,
        from_=from_,
        to=to,
        cursor=cursor,
        limit=limit,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    event_type: list[DeveloperAuditEventType] | Unset = UNSET,
    actor_profile_id: UUID | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> DeveloperAuditPage | ErrorEnvelope | None:
    """허용된 운영 감사 이벤트 조회

     계정·운영 event allowlist만 최대 31일, 페이지당 100건으로 조회합니다. cursor는 응답 값을 그대로 사용하고 raw
    before_state/after_state 대신 이벤트별 허용 필드 summary만 표시합니다.

    Args:
        event_type (list[DeveloperAuditEventType] | Unset):
        actor_profile_id (UUID | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeveloperAuditPage | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            event_type=event_type,
            actor_profile_id=actor_profile_id,
            from_=from_,
            to=to,
            cursor=cursor,
            limit=limit,
        )
    ).parsed
