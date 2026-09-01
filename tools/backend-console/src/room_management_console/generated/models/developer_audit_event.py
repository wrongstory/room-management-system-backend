from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define

from ..models.developer_audit_event_type import DeveloperAuditEventType

if TYPE_CHECKING:
    from ..models.developer_audit_event_summary import DeveloperAuditEventSummary


T = TypeVar("T", bound="DeveloperAuditEvent")


@_attrs_define
class DeveloperAuditEvent:
    """
    Attributes:
        id (UUID):
        event_type (DeveloperAuditEventType): 운영 콘솔에 노출할 수 있도록 서버에서 고정한 감사 이벤트 allowlist
        entity_type (str):
        entity_id (None | UUID):
        actor_profile_id (None | UUID):
        actor_display_name (None | str):
        effective_at (datetime.datetime):
        recorded_at (datetime.datetime):
        reason_code (None | str):
        summary (DeveloperAuditEventSummary): 이벤트 종류별로 서버가 승인한 표시 필드만 포함하며 raw before_state/after_state는 반환하지 않습니다.
    """

    id: UUID
    event_type: DeveloperAuditEventType
    entity_type: str
    entity_id: None | UUID
    actor_profile_id: None | UUID
    actor_display_name: None | str
    effective_at: datetime.datetime
    recorded_at: datetime.datetime
    reason_code: None | str
    summary: DeveloperAuditEventSummary

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        event_type = self.event_type.value

        entity_type = self.entity_type

        entity_id: None | str
        if isinstance(self.entity_id, UUID):
            entity_id = str(self.entity_id)
        else:
            entity_id = self.entity_id

        actor_profile_id: None | str
        if isinstance(self.actor_profile_id, UUID):
            actor_profile_id = str(self.actor_profile_id)
        else:
            actor_profile_id = self.actor_profile_id

        actor_display_name: None | str
        actor_display_name = self.actor_display_name

        effective_at = self.effective_at.isoformat()

        recorded_at = self.recorded_at.isoformat()

        reason_code: None | str
        reason_code = self.reason_code

        summary = self.summary.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "eventType": event_type,
                "entityType": entity_type,
                "entityId": entity_id,
                "actorProfileId": actor_profile_id,
                "actorDisplayName": actor_display_name,
                "effectiveAt": effective_at,
                "recordedAt": recorded_at,
                "reasonCode": reason_code,
                "summary": summary,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_audit_event_summary import DeveloperAuditEventSummary

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        event_type = DeveloperAuditEventType(d.pop("eventType"))

        entity_type = d.pop("entityType")

        def _parse_entity_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                entity_id_type_0 = UUID(data)

                return entity_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        entity_id = _parse_entity_id(d.pop("entityId"))

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

        def _parse_actor_display_name(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        actor_display_name = _parse_actor_display_name(d.pop("actorDisplayName"))

        effective_at = datetime.datetime.fromisoformat(d.pop("effectiveAt"))

        recorded_at = datetime.datetime.fromisoformat(d.pop("recordedAt"))

        def _parse_reason_code(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        reason_code = _parse_reason_code(d.pop("reasonCode"))

        summary = DeveloperAuditEventSummary.from_dict(d.pop("summary"))

        developer_audit_event = cls(
            id=id,
            event_type=event_type,
            entity_type=entity_type,
            entity_id=entity_id,
            actor_profile_id=actor_profile_id,
            actor_display_name=actor_display_name,
            effective_at=effective_at,
            recorded_at=recorded_at,
            reason_code=reason_code,
            summary=summary,
        )

        return developer_audit_event
