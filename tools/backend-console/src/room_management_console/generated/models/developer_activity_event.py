from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define

from ..models.activity_category import ActivityCategory
from ..models.activity_event_type import ActivityEventType
from ..models.activity_outcome import ActivityOutcome
from ..models.app_role import AppRole

if TYPE_CHECKING:
    from ..models.developer_activity_event_summary import DeveloperActivityEventSummary


T = TypeVar("T", bound="DeveloperActivityEvent")


@_attrs_define
class DeveloperActivityEvent:
    """
    Attributes:
        id (UUID):
        category (ActivityCategory):
        event_type (ActivityEventType):
        outcome (ActivityOutcome):
        actor_profile_id (None | UUID):
        actor_role (AppRole | None):
        source (str): 소스 코드에 고정된 capability category
        resource_type (None | str):
        resource_id (None | UUID):
        reason_code (None | str):
        request_id (None | UUID): 개별 이벤트에만 존재하는 Edge 생성 UUID v4입니다. caller X-Request-ID나 세션 ID가 아닙니다.
        occurred_at (datetime.datetime):
        recorded_at (datetime.datetime):
        summary (DeveloperActivityEventSummary): unknown login과 authorization denial aggregate에
            count/lastOccurredAt/bucketMinutes를 반환합니다.
    """

    id: UUID
    category: ActivityCategory
    event_type: ActivityEventType
    outcome: ActivityOutcome
    actor_profile_id: None | UUID
    actor_role: AppRole | None
    source: str
    resource_type: None | str
    resource_id: None | UUID
    reason_code: None | str
    request_id: None | UUID
    occurred_at: datetime.datetime
    recorded_at: datetime.datetime
    summary: DeveloperActivityEventSummary

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        category = self.category.value

        event_type = self.event_type.value

        outcome = self.outcome.value

        actor_profile_id: None | str
        if isinstance(self.actor_profile_id, UUID):
            actor_profile_id = str(self.actor_profile_id)
        else:
            actor_profile_id = self.actor_profile_id

        actor_role: None | str
        if isinstance(self.actor_role, AppRole):
            actor_role = self.actor_role.value
        else:
            actor_role = self.actor_role

        source = self.source

        resource_type: None | str
        resource_type = self.resource_type

        resource_id: None | str
        if isinstance(self.resource_id, UUID):
            resource_id = str(self.resource_id)
        else:
            resource_id = self.resource_id

        reason_code: None | str
        reason_code = self.reason_code

        request_id: None | str
        if isinstance(self.request_id, UUID):
            request_id = str(self.request_id)
        else:
            request_id = self.request_id

        occurred_at = self.occurred_at.isoformat()

        recorded_at = self.recorded_at.isoformat()

        summary = self.summary.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "category": category,
                "eventType": event_type,
                "outcome": outcome,
                "actorProfileId": actor_profile_id,
                "actorRole": actor_role,
                "source": source,
                "resourceType": resource_type,
                "resourceId": resource_id,
                "reasonCode": reason_code,
                "requestId": request_id,
                "occurredAt": occurred_at,
                "recordedAt": recorded_at,
                "summary": summary,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_activity_event_summary import DeveloperActivityEventSummary

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        category = ActivityCategory(d.pop("category"))

        event_type = ActivityEventType(d.pop("eventType"))

        outcome = ActivityOutcome(d.pop("outcome"))

        def _parse_actor_profile_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                actor_profile_id_type_0 = UUID(data)

                return actor_profile_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        actor_profile_id = _parse_actor_profile_id(d.pop("actorProfileId"))

        def _parse_actor_role(data: object) -> AppRole | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                actor_role_type_0 = AppRole(data)

                return actor_role_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(AppRole | None, data)

        actor_role = _parse_actor_role(d.pop("actorRole"))

        source = d.pop("source")

        def _parse_resource_type(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        resource_type = _parse_resource_type(d.pop("resourceType"))

        def _parse_resource_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                resource_id_type_0 = UUID(data)

                return resource_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        resource_id = _parse_resource_id(d.pop("resourceId"))

        def _parse_reason_code(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        reason_code = _parse_reason_code(d.pop("reasonCode"))

        def _parse_request_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                request_id_type_0 = UUID(data)

                return request_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        request_id = _parse_request_id(d.pop("requestId"))

        occurred_at = datetime.datetime.fromisoformat(d.pop("occurredAt"))

        recorded_at = datetime.datetime.fromisoformat(d.pop("recordedAt"))

        summary = DeveloperActivityEventSummary.from_dict(d.pop("summary"))

        developer_activity_event = cls(
            id=id,
            category=category,
            event_type=event_type,
            outcome=outcome,
            actor_profile_id=actor_profile_id,
            actor_role=actor_role,
            source=source,
            resource_type=resource_type,
            resource_id=resource_id,
            reason_code=reason_code,
            request_id=request_id,
            occurred_at=occurred_at,
            recorded_at=recorded_at,
            summary=summary,
        )

        return developer_activity_event
