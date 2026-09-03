from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

from ..models.app_role import AppRole
from ..types import UNSET, Unset

T = TypeVar("T", bound="DeveloperAuditEventSummary")


@_attrs_define
class DeveloperAuditEventSummary:
    """이벤트 종류별로 서버가 승인한 표시 필드만 포함하며 raw before_state/after_state는 반환하지 않습니다.

    Attributes:
        display_name (str | Unset):
        login_id (str | Unset):
        role (AppRole | Unset): developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.
        status (str | Unset):
        must_change_password (bool | Unset):
        maid_profile_id (UUID | Unset):
        cleaning_target_id (UUID | Unset):
        assignment_id (UUID | Unset):
        week_start (datetime.date | Unset):
        version (int | Unset):
        source_version (int | Unset):
        approved_version_id (UUID | Unset):
        room_id (UUID | Unset):
        check_in_at (datetime.datetime | Unset):
        check_out_at (datetime.datetime | Unset):
        purged_count (int | Unset):
        reservation_id (UUID | Unset):
        cleaning_kind (str | Unset):
        service_date (datetime.date | Unset):
        sequence_number (int | Unset):
        revision (int | Unset):
        target_assignment_version (int | Unset):
        available_from (datetime.datetime | Unset):
        due_at (datetime.datetime | Unset):
        room_type_id (str | Unset):
        elevator_zone (str | Unset):
        data_status (str | Unset):
        state_version (int | Unset):
        block_id (UUID | Unset):
        active (bool | Unset):
        count (int | Unset):
        issue_id (UUID | Unset):
        category (str | Unset):
        severity (str | Unset):
        blocks_guest_assignment (bool | Unset):
        pin_sync_event_id (UUID | Unset):
        sync_status (str | Unset):
        pin_version (int | Unset):
    """

    display_name: str | Unset = UNSET
    login_id: str | Unset = UNSET
    role: AppRole | Unset = UNSET
    status: str | Unset = UNSET
    must_change_password: bool | Unset = UNSET
    maid_profile_id: UUID | Unset = UNSET
    cleaning_target_id: UUID | Unset = UNSET
    assignment_id: UUID | Unset = UNSET
    week_start: datetime.date | Unset = UNSET
    version: int | Unset = UNSET
    source_version: int | Unset = UNSET
    approved_version_id: UUID | Unset = UNSET
    room_id: UUID | Unset = UNSET
    check_in_at: datetime.datetime | Unset = UNSET
    check_out_at: datetime.datetime | Unset = UNSET
    purged_count: int | Unset = UNSET
    reservation_id: UUID | Unset = UNSET
    cleaning_kind: str | Unset = UNSET
    service_date: datetime.date | Unset = UNSET
    sequence_number: int | Unset = UNSET
    revision: int | Unset = UNSET
    target_assignment_version: int | Unset = UNSET
    available_from: datetime.datetime | Unset = UNSET
    due_at: datetime.datetime | Unset = UNSET
    room_type_id: str | Unset = UNSET
    elevator_zone: str | Unset = UNSET
    data_status: str | Unset = UNSET
    state_version: int | Unset = UNSET
    block_id: UUID | Unset = UNSET
    active: bool | Unset = UNSET
    count: int | Unset = UNSET
    issue_id: UUID | Unset = UNSET
    category: str | Unset = UNSET
    severity: str | Unset = UNSET
    blocks_guest_assignment: bool | Unset = UNSET
    pin_sync_event_id: UUID | Unset = UNSET
    sync_status: str | Unset = UNSET
    pin_version: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        display_name = self.display_name

        login_id = self.login_id

        role: str | Unset = UNSET
        if not isinstance(self.role, Unset):
            role = self.role.value

        status = self.status

        must_change_password = self.must_change_password

        maid_profile_id: str | Unset = UNSET
        if not isinstance(self.maid_profile_id, Unset):
            maid_profile_id = str(self.maid_profile_id)

        cleaning_target_id: str | Unset = UNSET
        if not isinstance(self.cleaning_target_id, Unset):
            cleaning_target_id = str(self.cleaning_target_id)

        assignment_id: str | Unset = UNSET
        if not isinstance(self.assignment_id, Unset):
            assignment_id = str(self.assignment_id)

        week_start: str | Unset = UNSET
        if not isinstance(self.week_start, Unset):
            week_start = self.week_start.isoformat()

        version = self.version

        source_version = self.source_version

        approved_version_id: str | Unset = UNSET
        if not isinstance(self.approved_version_id, Unset):
            approved_version_id = str(self.approved_version_id)

        room_id: str | Unset = UNSET
        if not isinstance(self.room_id, Unset):
            room_id = str(self.room_id)

        check_in_at: str | Unset = UNSET
        if not isinstance(self.check_in_at, Unset):
            check_in_at = self.check_in_at.isoformat()

        check_out_at: str | Unset = UNSET
        if not isinstance(self.check_out_at, Unset):
            check_out_at = self.check_out_at.isoformat()

        purged_count = self.purged_count

        reservation_id: str | Unset = UNSET
        if not isinstance(self.reservation_id, Unset):
            reservation_id = str(self.reservation_id)

        cleaning_kind = self.cleaning_kind

        service_date: str | Unset = UNSET
        if not isinstance(self.service_date, Unset):
            service_date = self.service_date.isoformat()

        sequence_number = self.sequence_number

        revision = self.revision

        target_assignment_version = self.target_assignment_version

        available_from: str | Unset = UNSET
        if not isinstance(self.available_from, Unset):
            available_from = self.available_from.isoformat()

        due_at: str | Unset = UNSET
        if not isinstance(self.due_at, Unset):
            due_at = self.due_at.isoformat()

        room_type_id = self.room_type_id

        elevator_zone = self.elevator_zone

        data_status = self.data_status

        state_version = self.state_version

        block_id: str | Unset = UNSET
        if not isinstance(self.block_id, Unset):
            block_id = str(self.block_id)

        active = self.active

        count = self.count

        issue_id: str | Unset = UNSET
        if not isinstance(self.issue_id, Unset):
            issue_id = str(self.issue_id)

        category = self.category

        severity = self.severity

        blocks_guest_assignment = self.blocks_guest_assignment

        pin_sync_event_id: str | Unset = UNSET
        if not isinstance(self.pin_sync_event_id, Unset):
            pin_sync_event_id = str(self.pin_sync_event_id)

        sync_status = self.sync_status

        pin_version = self.pin_version

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if display_name is not UNSET:
            field_dict["displayName"] = display_name
        if login_id is not UNSET:
            field_dict["loginId"] = login_id
        if role is not UNSET:
            field_dict["role"] = role
        if status is not UNSET:
            field_dict["status"] = status
        if must_change_password is not UNSET:
            field_dict["mustChangePassword"] = must_change_password
        if maid_profile_id is not UNSET:
            field_dict["maidProfileId"] = maid_profile_id
        if cleaning_target_id is not UNSET:
            field_dict["cleaningTargetId"] = cleaning_target_id
        if assignment_id is not UNSET:
            field_dict["assignmentId"] = assignment_id
        if week_start is not UNSET:
            field_dict["weekStart"] = week_start
        if version is not UNSET:
            field_dict["version"] = version
        if source_version is not UNSET:
            field_dict["sourceVersion"] = source_version
        if approved_version_id is not UNSET:
            field_dict["approvedVersionId"] = approved_version_id
        if room_id is not UNSET:
            field_dict["roomId"] = room_id
        if check_in_at is not UNSET:
            field_dict["checkInAt"] = check_in_at
        if check_out_at is not UNSET:
            field_dict["checkOutAt"] = check_out_at
        if purged_count is not UNSET:
            field_dict["purgedCount"] = purged_count
        if reservation_id is not UNSET:
            field_dict["reservationId"] = reservation_id
        if cleaning_kind is not UNSET:
            field_dict["cleaningKind"] = cleaning_kind
        if service_date is not UNSET:
            field_dict["serviceDate"] = service_date
        if sequence_number is not UNSET:
            field_dict["sequenceNumber"] = sequence_number
        if revision is not UNSET:
            field_dict["revision"] = revision
        if target_assignment_version is not UNSET:
            field_dict["targetAssignmentVersion"] = target_assignment_version
        if available_from is not UNSET:
            field_dict["availableFrom"] = available_from
        if due_at is not UNSET:
            field_dict["dueAt"] = due_at
        if room_type_id is not UNSET:
            field_dict["roomTypeId"] = room_type_id
        if elevator_zone is not UNSET:
            field_dict["elevatorZone"] = elevator_zone
        if data_status is not UNSET:
            field_dict["dataStatus"] = data_status
        if state_version is not UNSET:
            field_dict["stateVersion"] = state_version
        if block_id is not UNSET:
            field_dict["blockId"] = block_id
        if active is not UNSET:
            field_dict["active"] = active
        if count is not UNSET:
            field_dict["count"] = count
        if issue_id is not UNSET:
            field_dict["issueId"] = issue_id
        if category is not UNSET:
            field_dict["category"] = category
        if severity is not UNSET:
            field_dict["severity"] = severity
        if blocks_guest_assignment is not UNSET:
            field_dict["blocksGuestAssignment"] = blocks_guest_assignment
        if pin_sync_event_id is not UNSET:
            field_dict["pinSyncEventId"] = pin_sync_event_id
        if sync_status is not UNSET:
            field_dict["syncStatus"] = sync_status
        if pin_version is not UNSET:
            field_dict["pinVersion"] = pin_version

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        display_name = d.pop("displayName", UNSET)

        login_id = d.pop("loginId", UNSET)

        _role = d.pop("role", UNSET)
        role: AppRole | Unset
        if isinstance(_role, Unset):
            role = UNSET
        else:
            role = AppRole(_role)

        status = d.pop("status", UNSET)

        must_change_password = d.pop("mustChangePassword", UNSET)

        _maid_profile_id = d.pop("maidProfileId", UNSET)
        maid_profile_id: UUID | Unset
        if isinstance(_maid_profile_id, Unset):
            maid_profile_id = UNSET
        else:
            maid_profile_id = UUID(_maid_profile_id)

        _cleaning_target_id = d.pop("cleaningTargetId", UNSET)
        cleaning_target_id: UUID | Unset
        if isinstance(_cleaning_target_id, Unset):
            cleaning_target_id = UNSET
        else:
            cleaning_target_id = UUID(_cleaning_target_id)

        _assignment_id = d.pop("assignmentId", UNSET)
        assignment_id: UUID | Unset
        if isinstance(_assignment_id, Unset):
            assignment_id = UNSET
        else:
            assignment_id = UUID(_assignment_id)

        _week_start = d.pop("weekStart", UNSET)
        week_start: datetime.date | Unset
        if isinstance(_week_start, Unset):
            week_start = UNSET
        else:
            week_start = datetime.date.fromisoformat(_week_start)

        version = d.pop("version", UNSET)

        source_version = d.pop("sourceVersion", UNSET)

        _approved_version_id = d.pop("approvedVersionId", UNSET)
        approved_version_id: UUID | Unset
        if isinstance(_approved_version_id, Unset):
            approved_version_id = UNSET
        else:
            approved_version_id = UUID(_approved_version_id)

        _room_id = d.pop("roomId", UNSET)
        room_id: UUID | Unset
        if isinstance(_room_id, Unset):
            room_id = UNSET
        else:
            room_id = UUID(_room_id)

        _check_in_at = d.pop("checkInAt", UNSET)
        check_in_at: datetime.datetime | Unset
        if isinstance(_check_in_at, Unset):
            check_in_at = UNSET
        else:
            check_in_at = datetime.datetime.fromisoformat(_check_in_at)

        _check_out_at = d.pop("checkOutAt", UNSET)
        check_out_at: datetime.datetime | Unset
        if isinstance(_check_out_at, Unset):
            check_out_at = UNSET
        else:
            check_out_at = datetime.datetime.fromisoformat(_check_out_at)

        purged_count = d.pop("purgedCount", UNSET)

        _reservation_id = d.pop("reservationId", UNSET)
        reservation_id: UUID | Unset
        if isinstance(_reservation_id, Unset):
            reservation_id = UNSET
        else:
            reservation_id = UUID(_reservation_id)

        cleaning_kind = d.pop("cleaningKind", UNSET)

        _service_date = d.pop("serviceDate", UNSET)
        service_date: datetime.date | Unset
        if isinstance(_service_date, Unset):
            service_date = UNSET
        else:
            service_date = datetime.date.fromisoformat(_service_date)

        sequence_number = d.pop("sequenceNumber", UNSET)

        revision = d.pop("revision", UNSET)

        target_assignment_version = d.pop("targetAssignmentVersion", UNSET)

        _available_from = d.pop("availableFrom", UNSET)
        available_from: datetime.datetime | Unset
        if isinstance(_available_from, Unset):
            available_from = UNSET
        else:
            available_from = datetime.datetime.fromisoformat(_available_from)

        _due_at = d.pop("dueAt", UNSET)
        due_at: datetime.datetime | Unset
        if isinstance(_due_at, Unset):
            due_at = UNSET
        else:
            due_at = datetime.datetime.fromisoformat(_due_at)

        room_type_id = d.pop("roomTypeId", UNSET)

        elevator_zone = d.pop("elevatorZone", UNSET)

        data_status = d.pop("dataStatus", UNSET)

        state_version = d.pop("stateVersion", UNSET)

        _block_id = d.pop("blockId", UNSET)
        block_id: UUID | Unset
        if isinstance(_block_id, Unset):
            block_id = UNSET
        else:
            block_id = UUID(_block_id)

        active = d.pop("active", UNSET)

        count = d.pop("count", UNSET)

        _issue_id = d.pop("issueId", UNSET)
        issue_id: UUID | Unset
        if isinstance(_issue_id, Unset):
            issue_id = UNSET
        else:
            issue_id = UUID(_issue_id)

        category = d.pop("category", UNSET)

        severity = d.pop("severity", UNSET)

        blocks_guest_assignment = d.pop("blocksGuestAssignment", UNSET)

        _pin_sync_event_id = d.pop("pinSyncEventId", UNSET)
        pin_sync_event_id: UUID | Unset
        if isinstance(_pin_sync_event_id, Unset):
            pin_sync_event_id = UNSET
        else:
            pin_sync_event_id = UUID(_pin_sync_event_id)

        sync_status = d.pop("syncStatus", UNSET)

        pin_version = d.pop("pinVersion", UNSET)

        developer_audit_event_summary = cls(
            display_name=display_name,
            login_id=login_id,
            role=role,
            status=status,
            must_change_password=must_change_password,
            maid_profile_id=maid_profile_id,
            cleaning_target_id=cleaning_target_id,
            assignment_id=assignment_id,
            week_start=week_start,
            version=version,
            source_version=source_version,
            approved_version_id=approved_version_id,
            room_id=room_id,
            check_in_at=check_in_at,
            check_out_at=check_out_at,
            purged_count=purged_count,
            reservation_id=reservation_id,
            cleaning_kind=cleaning_kind,
            service_date=service_date,
            sequence_number=sequence_number,
            revision=revision,
            target_assignment_version=target_assignment_version,
            available_from=available_from,
            due_at=due_at,
            room_type_id=room_type_id,
            elevator_zone=elevator_zone,
            data_status=data_status,
            state_version=state_version,
            block_id=block_id,
            active=active,
            count=count,
            issue_id=issue_id,
            category=category,
            severity=severity,
            blocks_guest_assignment=blocks_guest_assignment,
            pin_sync_event_id=pin_sync_event_id,
            sync_status=sync_status,
            pin_version=pin_version,
        )

        return developer_audit_event_summary
