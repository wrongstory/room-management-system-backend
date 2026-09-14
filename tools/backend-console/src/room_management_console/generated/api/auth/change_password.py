from http import HTTPStatus
from typing import Any, cast

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_envelope import ErrorEnvelope
from ...models.password_change_request import PasswordChangeRequest
from ...types import Response


def _get_kwargs(
    *,
    body: PasswordChangeRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/auth/password",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | ErrorEnvelope | None:
    if response.status_code == 204:
        response_204 = cast(Any, None)
        return response_204

    if response.status_code == 400:
        response_400 = ErrorEnvelope.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorEnvelope.from_dict(response.json())

        return response_401

    if response.status_code == 409:
        response_409 = ErrorEnvelope.from_dict(response.json())

        return response_409

    if response.status_code == 429:
        response_429 = ErrorEnvelope.from_dict(response.json())

        return response_429

    if response.status_code == 500:
        response_500 = ErrorEnvelope.from_dict(response.json())

        return response_500

    if response.status_code == 502:
        response_502 = ErrorEnvelope.from_dict(response.json())

        return response_502

    if response.status_code == 503:
        response_503 = ErrorEnvelope.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Any | ErrorEnvelope]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: PasswordChangeRequest,
    idempotency_key: str,
) -> Response[Any | ErrorEnvelope]:
    """현재 또는 임시 비밀번호를 개인 비밀번호로 변경

     모든 active 역할이 본인 비밀번호를 변경할 때 사용합니다. 새 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합입니다. timeout/응답
    유실 시 같은 Idempotency-Key와 원래 요청 body를 다시 보내세요. 서버는 비밀번호 파생 fingerprint를 저장하지 않으므로 currentPassword의
    byte equality는 durable receipt에 포함하지 않습니다. 대신 Auth 비밀번호 변경 때만 회전하는 private effect version과 재전송한
    newPassword가 현재 Auth 상태에 함께 일치할 때만 동일한 의도 효과로 증명하여 204를 replay합니다. 이후 변경·관리자 초기화·별도 Auth password
    변경으로 version이 바뀐 과거 key는 409가 됩니다. 모든 Auth 비밀번호 확인은 세션·client·key 회전으로 우회할 수 없는 actor 단위 durable
    rate limit을 먼저 소비하며, 한도 초과는 429입니다. 처리 중에는 PASSWORD_CHANGE_IN_PROGRESS이며 성공하면 현재 세션을 제외한 다른 세션이
    폐기됩니다.

    Args:
        idempotency_key (str):
        body (PasswordChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | ErrorEnvelope]
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
    body: PasswordChangeRequest,
    idempotency_key: str,
) -> Any | ErrorEnvelope | None:
    """현재 또는 임시 비밀번호를 개인 비밀번호로 변경

     모든 active 역할이 본인 비밀번호를 변경할 때 사용합니다. 새 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합입니다. timeout/응답
    유실 시 같은 Idempotency-Key와 원래 요청 body를 다시 보내세요. 서버는 비밀번호 파생 fingerprint를 저장하지 않으므로 currentPassword의
    byte equality는 durable receipt에 포함하지 않습니다. 대신 Auth 비밀번호 변경 때만 회전하는 private effect version과 재전송한
    newPassword가 현재 Auth 상태에 함께 일치할 때만 동일한 의도 효과로 증명하여 204를 replay합니다. 이후 변경·관리자 초기화·별도 Auth password
    변경으로 version이 바뀐 과거 key는 409가 됩니다. 모든 Auth 비밀번호 확인은 세션·client·key 회전으로 우회할 수 없는 actor 단위 durable
    rate limit을 먼저 소비하며, 한도 초과는 429입니다. 처리 중에는 PASSWORD_CHANGE_IN_PROGRESS이며 성공하면 현재 세션을 제외한 다른 세션이
    폐기됩니다.

    Args:
        idempotency_key (str):
        body (PasswordChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | ErrorEnvelope
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: PasswordChangeRequest,
    idempotency_key: str,
) -> Response[Any | ErrorEnvelope]:
    """현재 또는 임시 비밀번호를 개인 비밀번호로 변경

     모든 active 역할이 본인 비밀번호를 변경할 때 사용합니다. 새 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합입니다. timeout/응답
    유실 시 같은 Idempotency-Key와 원래 요청 body를 다시 보내세요. 서버는 비밀번호 파생 fingerprint를 저장하지 않으므로 currentPassword의
    byte equality는 durable receipt에 포함하지 않습니다. 대신 Auth 비밀번호 변경 때만 회전하는 private effect version과 재전송한
    newPassword가 현재 Auth 상태에 함께 일치할 때만 동일한 의도 효과로 증명하여 204를 replay합니다. 이후 변경·관리자 초기화·별도 Auth password
    변경으로 version이 바뀐 과거 key는 409가 됩니다. 모든 Auth 비밀번호 확인은 세션·client·key 회전으로 우회할 수 없는 actor 단위 durable
    rate limit을 먼저 소비하며, 한도 초과는 429입니다. 처리 중에는 PASSWORD_CHANGE_IN_PROGRESS이며 성공하면 현재 세션을 제외한 다른 세션이
    폐기됩니다.

    Args:
        idempotency_key (str):
        body (PasswordChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | ErrorEnvelope]
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
    body: PasswordChangeRequest,
    idempotency_key: str,
) -> Any | ErrorEnvelope | None:
    """현재 또는 임시 비밀번호를 개인 비밀번호로 변경

     모든 active 역할이 본인 비밀번호를 변경할 때 사용합니다. 새 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합입니다. timeout/응답
    유실 시 같은 Idempotency-Key와 원래 요청 body를 다시 보내세요. 서버는 비밀번호 파생 fingerprint를 저장하지 않으므로 currentPassword의
    byte equality는 durable receipt에 포함하지 않습니다. 대신 Auth 비밀번호 변경 때만 회전하는 private effect version과 재전송한
    newPassword가 현재 Auth 상태에 함께 일치할 때만 동일한 의도 효과로 증명하여 204를 replay합니다. 이후 변경·관리자 초기화·별도 Auth password
    변경으로 version이 바뀐 과거 key는 409가 됩니다. 모든 Auth 비밀번호 확인은 세션·client·key 회전으로 우회할 수 없는 actor 단위 durable
    rate limit을 먼저 소비하며, 한도 초과는 429입니다. 처리 중에는 PASSWORD_CHANGE_IN_PROGRESS이며 성공하면 현재 세션을 제외한 다른 세션이
    폐기됩니다.

    Args:
        idempotency_key (str):
        body (PasswordChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | ErrorEnvelope
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
