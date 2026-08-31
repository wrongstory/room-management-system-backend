import datetime
from http import HTTPStatus
from typing import Any
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.activity_category import ActivityCategory
from ...models.activity_event_type import ActivityEventType
from ...models.activity_outcome import ActivityOutcome
from ...models.app_role import AppRole
from ...models.developer_activity_page import DeveloperActivityPage
from ...models.error_envelope import ErrorEnvelope
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    actor_profile_id: UUID | Unset = UNSET,
    role: AppRole | Unset = UNSET,
    category: list[ActivityCategory] | Unset = UNSET,
    event_type: list[ActivityEventType] | Unset = UNSET,
    outcome: list[ActivityOutcome] | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_actor_profile_id: str | Unset = UNSET
    if not isinstance(actor_profile_id, Unset):
        json_actor_profile_id = str(actor_profile_id)
    params["actorProfileId"] = json_actor_profile_id

    json_role: str | Unset = UNSET
    if not isinstance(role, Unset):
        json_role = role.value

    params["role"] = json_role

    json_category: list[str] | Unset = UNSET
    if not isinstance(category, Unset):
        json_category = []
        for category_item_data in category:
            category_item = category_item_data.value
            json_category.append(category_item)

    params["category"] = json_category

    json_event_type: list[str] | Unset = UNSET
    if not isinstance(event_type, Unset):
        json_event_type = []
        for event_type_item_data in event_type:
            event_type_item = event_type_item_data.value
            json_event_type.append(event_type_item)

    params["eventType"] = json_event_type

    json_outcome: list[str] | Unset = UNSET
    if not isinstance(outcome, Unset):
        json_outcome = []
        for outcome_item_data in outcome:
            outcome_item = outcome_item_data.value
            json_outcome.append(outcome_item)

    params["outcome"] = json_outcome

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
        "url": "/v1/developer/activity-events",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> DeveloperActivityPage | ErrorEnvelope | None:
    if response.status_code == 200:
        response_200 = DeveloperActivityPage.from_dict(response.json())

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

    if response.status_code == 503:
        response_503 = ErrorEnvelope.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[DeveloperActivityPage | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    actor_profile_id: UUID | Unset = UNSET,
    role: AppRole | Unset = UNSET,
    category: list[ActivityCategory] | Unset = UNSET,
    event_type: list[ActivityEventType] | Unset = UNSET,
    outcome: list[ActivityOutcome] | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> Response[DeveloperActivityPage | ErrorEnvelope]:
    """인증·권한·민감접근 활동 로그 조회

     업무 상태 변경 감사와 분리된 보안 활동을 최대 31일, 페이지당 100건으로 조회합니다. 알 수 없는 로그인 ID 공격은 원문 없이 분 단위 aggregate summary로만
    반환합니다.

    Args:
        actor_profile_id (UUID | Unset):
        role (AppRole | Unset): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        category (list[ActivityCategory] | Unset):
        event_type (list[ActivityEventType] | Unset):
        outcome (list[ActivityOutcome] | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeveloperActivityPage | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        actor_profile_id=actor_profile_id,
        role=role,
        category=category,
        event_type=event_type,
        outcome=outcome,
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
    actor_profile_id: UUID | Unset = UNSET,
    role: AppRole | Unset = UNSET,
    category: list[ActivityCategory] | Unset = UNSET,
    event_type: list[ActivityEventType] | Unset = UNSET,
    outcome: list[ActivityOutcome] | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> DeveloperActivityPage | ErrorEnvelope | None:
    """인증·권한·민감접근 활동 로그 조회

     업무 상태 변경 감사와 분리된 보안 활동을 최대 31일, 페이지당 100건으로 조회합니다. 알 수 없는 로그인 ID 공격은 원문 없이 분 단위 aggregate summary로만
    반환합니다.

    Args:
        actor_profile_id (UUID | Unset):
        role (AppRole | Unset): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        category (list[ActivityCategory] | Unset):
        event_type (list[ActivityEventType] | Unset):
        outcome (list[ActivityOutcome] | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeveloperActivityPage | ErrorEnvelope
    """

    return sync_detailed(
        client=client,
        actor_profile_id=actor_profile_id,
        role=role,
        category=category,
        event_type=event_type,
        outcome=outcome,
        from_=from_,
        to=to,
        cursor=cursor,
        limit=limit,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    actor_profile_id: UUID | Unset = UNSET,
    role: AppRole | Unset = UNSET,
    category: list[ActivityCategory] | Unset = UNSET,
    event_type: list[ActivityEventType] | Unset = UNSET,
    outcome: list[ActivityOutcome] | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> Response[DeveloperActivityPage | ErrorEnvelope]:
    """인증·권한·민감접근 활동 로그 조회

     업무 상태 변경 감사와 분리된 보안 활동을 최대 31일, 페이지당 100건으로 조회합니다. 알 수 없는 로그인 ID 공격은 원문 없이 분 단위 aggregate summary로만
    반환합니다.

    Args:
        actor_profile_id (UUID | Unset):
        role (AppRole | Unset): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        category (list[ActivityCategory] | Unset):
        event_type (list[ActivityEventType] | Unset):
        outcome (list[ActivityOutcome] | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeveloperActivityPage | ErrorEnvelope]
    """

    kwargs = _get_kwargs(
        actor_profile_id=actor_profile_id,
        role=role,
        category=category,
        event_type=event_type,
        outcome=outcome,
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
    actor_profile_id: UUID | Unset = UNSET,
    role: AppRole | Unset = UNSET,
    category: list[ActivityCategory] | Unset = UNSET,
    event_type: list[ActivityEventType] | Unset = UNSET,
    outcome: list[ActivityOutcome] | Unset = UNSET,
    from_: datetime.datetime | Unset = UNSET,
    to: datetime.datetime | Unset = UNSET,
    cursor: str | Unset = UNSET,
    limit: int | Unset = 50,
) -> DeveloperActivityPage | ErrorEnvelope | None:
    """인증·권한·민감접근 활동 로그 조회

     업무 상태 변경 감사와 분리된 보안 활동을 최대 31일, 페이지당 100건으로 조회합니다. 알 수 없는 로그인 ID 공격은 원문 없이 분 단위 aggregate summary로만
    반환합니다.

    Args:
        actor_profile_id (UUID | Unset):
        role (AppRole | Unset): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        category (list[ActivityCategory] | Unset):
        event_type (list[ActivityEventType] | Unset):
        outcome (list[ActivityOutcome] | Unset):
        from_ (datetime.datetime | Unset):
        to (datetime.datetime | Unset):
        cursor (str | Unset):
        limit (int | Unset):  Default: 50.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeveloperActivityPage | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            actor_profile_id=actor_profile_id,
            role=role,
            category=category,
            event_type=event_type,
            outcome=outcome,
            from_=from_,
            to=to,
            cursor=cursor,
            limit=limit,
        )
    ).parsed
