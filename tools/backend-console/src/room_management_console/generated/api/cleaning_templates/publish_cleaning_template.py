from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.publish_cleaning_template_request import PublishCleaningTemplateRequest
from ...models.published_cleaning_template_envelope import PublishedCleaningTemplateEnvelope
from ...types import Response


def _get_kwargs(
    *,
    body: PublishCleaningTemplateRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/cleaning-templates",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorEnvelope | PublishedCleaningTemplateEnvelope | None:
    if response.status_code == 201:
        response_201 = PublishedCleaningTemplateEnvelope.from_dict(response.json())

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

    if response.status_code == 500:
        response_500 = ErrorEnvelope.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorEnvelope | PublishedCleaningTemplateEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: PublishCleaningTemplateRequest,
    idempotency_key: str,
) -> Response[ErrorEnvelope | PublishedCleaningTemplateEnvelope]:
    """퇴실 청소 템플릿의 불변 새 버전 게시

     active business admin/live session 전용 command입니다. 한 객실 유형의 current published version을
    expectedVersion(최초 0)으로 CAS 검증하고, 기존 published를 retired로 보존한 뒤 A-contract v8 이상 immutable version과
    normalized slot rows를 원자 게시합니다. 기존 maxPhotos 없는 pre-A v7+ snapshot은 재작성하지 않습니다. 같은
    actor/command/Idempotency-Key와 canonical request hash는 replay되고 다른 payload 재사용은 409입니다. 게시 자체는 수신자의
    행동을 요구하지 않아 notification/outbox를 만들지 않습니다.

    Args:
        idempotency_key (str):
        body (PublishCleaningTemplateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | PublishedCleaningTemplateEnvelope]
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
    body: PublishCleaningTemplateRequest,
    idempotency_key: str,
) -> ErrorEnvelope | PublishedCleaningTemplateEnvelope | None:
    """퇴실 청소 템플릿의 불변 새 버전 게시

     active business admin/live session 전용 command입니다. 한 객실 유형의 current published version을
    expectedVersion(최초 0)으로 CAS 검증하고, 기존 published를 retired로 보존한 뒤 A-contract v8 이상 immutable version과
    normalized slot rows를 원자 게시합니다. 기존 maxPhotos 없는 pre-A v7+ snapshot은 재작성하지 않습니다. 같은
    actor/command/Idempotency-Key와 canonical request hash는 replay되고 다른 payload 재사용은 409입니다. 게시 자체는 수신자의
    행동을 요구하지 않아 notification/outbox를 만들지 않습니다.

    Args:
        idempotency_key (str):
        body (PublishCleaningTemplateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | PublishedCleaningTemplateEnvelope
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: PublishCleaningTemplateRequest,
    idempotency_key: str,
) -> Response[ErrorEnvelope | PublishedCleaningTemplateEnvelope]:
    """퇴실 청소 템플릿의 불변 새 버전 게시

     active business admin/live session 전용 command입니다. 한 객실 유형의 current published version을
    expectedVersion(최초 0)으로 CAS 검증하고, 기존 published를 retired로 보존한 뒤 A-contract v8 이상 immutable version과
    normalized slot rows를 원자 게시합니다. 기존 maxPhotos 없는 pre-A v7+ snapshot은 재작성하지 않습니다. 같은
    actor/command/Idempotency-Key와 canonical request hash는 replay되고 다른 payload 재사용은 409입니다. 게시 자체는 수신자의
    행동을 요구하지 않아 notification/outbox를 만들지 않습니다.

    Args:
        idempotency_key (str):
        body (PublishCleaningTemplateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorEnvelope | PublishedCleaningTemplateEnvelope]
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
    body: PublishCleaningTemplateRequest,
    idempotency_key: str,
) -> ErrorEnvelope | PublishedCleaningTemplateEnvelope | None:
    """퇴실 청소 템플릿의 불변 새 버전 게시

     active business admin/live session 전용 command입니다. 한 객실 유형의 current published version을
    expectedVersion(최초 0)으로 CAS 검증하고, 기존 published를 retired로 보존한 뒤 A-contract v8 이상 immutable version과
    normalized slot rows를 원자 게시합니다. 기존 maxPhotos 없는 pre-A v7+ snapshot은 재작성하지 않습니다. 같은
    actor/command/Idempotency-Key와 canonical request hash는 replay되고 다른 payload 재사용은 409입니다. 게시 자체는 수신자의
    행동을 요구하지 않아 notification/outbox를 만들지 않습니다.

    Args:
        idempotency_key (str):
        body (PublishCleaningTemplateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorEnvelope | PublishedCleaningTemplateEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
