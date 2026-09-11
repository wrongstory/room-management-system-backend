from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define

from ..models.app_role import AppRole
from ..models.developer_audit_event_summary_capability_kind import (
    DeveloperAuditEventSummaryCapabilityKind,
)
from ..models.developer_audit_event_summary_currency import DeveloperAuditEventSummaryCurrency
from ..models.developer_audit_event_summary_decision import DeveloperAuditEventSummaryDecision
from ..models.developer_audit_event_summary_payment_method import (
    DeveloperAuditEventSummaryPaymentMethod,
)
from ..models.developer_audit_event_summary_profile_status import (
    DeveloperAuditEventSummaryProfileStatus,
)
from ..models.developer_audit_event_summary_resolution import DeveloperAuditEventSummaryResolution
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
        previous_assignment_id (UUID | Unset):
        previous_maid_profile_id (UUID | Unset):
        request_id (UUID | Unset):
        decision (DeveloperAuditEventSummaryDecision | Unset):
        reason_code (str | Unset):
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
        attempt_id (UUID | Unset):
        submission_id (UUID | Unset):
        bomb_report_id (UUID | Unset):
        earning_id (UUID | Unset):
        reclean_target_id (UUID | Unset):
        evidence_count (int | Unset):
        photo_count (int | Unset):
        current_revision (int | Unset):
        attempt_number (int | Unset):
        assignment_revision (int | Unset):
        execution_version (int | Unset):
        started_at (datetime.datetime | Unset):
        field_completed_at (datetime.datetime | Unset):
        ended_at (datetime.datetime | Unset):
        capability_kind (DeveloperAuditEventSummaryCapabilityKind | Unset):
        expires_at (datetime.datetime | Unset):
        profile_status (DeveloperAuditEventSummaryProfileStatus | Unset):
        profile_version (int | Unset):
        next_attempt_id (UUID | Unset):
        target_slot_id (UUID | Unset):
        photo_id (UUID | Unset):
        photo_version (int | Unset):
        uploaded_at (datetime.datetime | Unset):
        purge_after (datetime.datetime | Unset):
        offline_quarantine_id (UUID | Unset): 서버 발급 격리 기록 ID. 원 client event UUID가 아닙니다.
        resolution (DeveloperAuditEventSummaryResolution | Unset):
        rollover_from_date (datetime.date | Unset):
        rollover_to_date (datetime.date | Unset):
        carryover_count (int | Unset):
        policy_version (int | Unset):
        standard_minutes (int | Unset):
        premium_minutes (int | Unset):
        ocean_premium_minutes (int | Unset):
        ocean_family_minutes (int | Unset):
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
        complaint_id (UUID | Unset):
        source_complaint_decision_id (UUID | Unset):
        compensation_decision_id (UUID | Unset):
        rework_cleaning_target_id (UUID | Unset):
        inspection_decision_id (UUID | Unset):
        same_maid (bool | Unset):
        compensation_amount (int | Unset):
        amount (int | Unset):
        currency (DeveloperAuditEventSummaryCurrency | Unset):
        case_version (int | Unset):
        payment_attempt_number (int | Unset):
        payment_method (DeveloperAuditEventSummaryPaymentMethod | Unset):
    """

    display_name: str | Unset = UNSET
    login_id: str | Unset = UNSET
    role: AppRole | Unset = UNSET
    status: str | Unset = UNSET
    must_change_password: bool | Unset = UNSET
    maid_profile_id: UUID | Unset = UNSET
    cleaning_target_id: UUID | Unset = UNSET
    assignment_id: UUID | Unset = UNSET
    previous_assignment_id: UUID | Unset = UNSET
    previous_maid_profile_id: UUID | Unset = UNSET
    request_id: UUID | Unset = UNSET
    decision: DeveloperAuditEventSummaryDecision | Unset = UNSET
    reason_code: str | Unset = UNSET
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
    attempt_id: UUID | Unset = UNSET
    submission_id: UUID | Unset = UNSET
    bomb_report_id: UUID | Unset = UNSET
    earning_id: UUID | Unset = UNSET
    reclean_target_id: UUID | Unset = UNSET
    evidence_count: int | Unset = UNSET
    photo_count: int | Unset = UNSET
    current_revision: int | Unset = UNSET
    attempt_number: int | Unset = UNSET
    assignment_revision: int | Unset = UNSET
    execution_version: int | Unset = UNSET
    started_at: datetime.datetime | Unset = UNSET
    field_completed_at: datetime.datetime | Unset = UNSET
    ended_at: datetime.datetime | Unset = UNSET
    capability_kind: DeveloperAuditEventSummaryCapabilityKind | Unset = UNSET
    expires_at: datetime.datetime | Unset = UNSET
    profile_status: DeveloperAuditEventSummaryProfileStatus | Unset = UNSET
    profile_version: int | Unset = UNSET
    next_attempt_id: UUID | Unset = UNSET
    target_slot_id: UUID | Unset = UNSET
    photo_id: UUID | Unset = UNSET
    photo_version: int | Unset = UNSET
    uploaded_at: datetime.datetime | Unset = UNSET
    purge_after: datetime.datetime | Unset = UNSET
    offline_quarantine_id: UUID | Unset = UNSET
    resolution: DeveloperAuditEventSummaryResolution | Unset = UNSET
    rollover_from_date: datetime.date | Unset = UNSET
    rollover_to_date: datetime.date | Unset = UNSET
    carryover_count: int | Unset = UNSET
    policy_version: int | Unset = UNSET
    standard_minutes: int | Unset = UNSET
    premium_minutes: int | Unset = UNSET
    ocean_premium_minutes: int | Unset = UNSET
    ocean_family_minutes: int | Unset = UNSET
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
    complaint_id: UUID | Unset = UNSET
    source_complaint_decision_id: UUID | Unset = UNSET
    compensation_decision_id: UUID | Unset = UNSET
    rework_cleaning_target_id: UUID | Unset = UNSET
    inspection_decision_id: UUID | Unset = UNSET
    same_maid: bool | Unset = UNSET
    compensation_amount: int | Unset = UNSET
    amount: int | Unset = UNSET
    currency: DeveloperAuditEventSummaryCurrency | Unset = UNSET
    case_version: int | Unset = UNSET
    payment_attempt_number: int | Unset = UNSET
    payment_method: DeveloperAuditEventSummaryPaymentMethod | Unset = UNSET

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

        previous_assignment_id: str | Unset = UNSET
        if not isinstance(self.previous_assignment_id, Unset):
            previous_assignment_id = str(self.previous_assignment_id)

        previous_maid_profile_id: str | Unset = UNSET
        if not isinstance(self.previous_maid_profile_id, Unset):
            previous_maid_profile_id = str(self.previous_maid_profile_id)

        request_id: str | Unset = UNSET
        if not isinstance(self.request_id, Unset):
            request_id = str(self.request_id)

        decision: str | Unset = UNSET
        if not isinstance(self.decision, Unset):
            decision = self.decision.value

        reason_code = self.reason_code

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

        attempt_id: str | Unset = UNSET
        if not isinstance(self.attempt_id, Unset):
            attempt_id = str(self.attempt_id)

        submission_id: str | Unset = UNSET
        if not isinstance(self.submission_id, Unset):
            submission_id = str(self.submission_id)

        bomb_report_id: str | Unset = UNSET
        if not isinstance(self.bomb_report_id, Unset):
            bomb_report_id = str(self.bomb_report_id)

        earning_id: str | Unset = UNSET
        if not isinstance(self.earning_id, Unset):
            earning_id = str(self.earning_id)

        reclean_target_id: str | Unset = UNSET
        if not isinstance(self.reclean_target_id, Unset):
            reclean_target_id = str(self.reclean_target_id)

        evidence_count = self.evidence_count

        photo_count = self.photo_count

        current_revision = self.current_revision

        attempt_number = self.attempt_number

        assignment_revision = self.assignment_revision

        execution_version = self.execution_version

        started_at: str | Unset = UNSET
        if not isinstance(self.started_at, Unset):
            started_at = self.started_at.isoformat()

        field_completed_at: str | Unset = UNSET
        if not isinstance(self.field_completed_at, Unset):
            field_completed_at = self.field_completed_at.isoformat()

        ended_at: str | Unset = UNSET
        if not isinstance(self.ended_at, Unset):
            ended_at = self.ended_at.isoformat()

        capability_kind: str | Unset = UNSET
        if not isinstance(self.capability_kind, Unset):
            capability_kind = self.capability_kind.value

        expires_at: str | Unset = UNSET
        if not isinstance(self.expires_at, Unset):
            expires_at = self.expires_at.isoformat()

        profile_status: str | Unset = UNSET
        if not isinstance(self.profile_status, Unset):
            profile_status = self.profile_status.value

        profile_version = self.profile_version

        next_attempt_id: str | Unset = UNSET
        if not isinstance(self.next_attempt_id, Unset):
            next_attempt_id = str(self.next_attempt_id)

        target_slot_id: str | Unset = UNSET
        if not isinstance(self.target_slot_id, Unset):
            target_slot_id = str(self.target_slot_id)

        photo_id: str | Unset = UNSET
        if not isinstance(self.photo_id, Unset):
            photo_id = str(self.photo_id)

        photo_version = self.photo_version

        uploaded_at: str | Unset = UNSET
        if not isinstance(self.uploaded_at, Unset):
            uploaded_at = self.uploaded_at.isoformat()

        purge_after: str | Unset = UNSET
        if not isinstance(self.purge_after, Unset):
            purge_after = self.purge_after.isoformat()

        offline_quarantine_id: str | Unset = UNSET
        if not isinstance(self.offline_quarantine_id, Unset):
            offline_quarantine_id = str(self.offline_quarantine_id)

        resolution: str | Unset = UNSET
        if not isinstance(self.resolution, Unset):
            resolution = self.resolution.value

        rollover_from_date: str | Unset = UNSET
        if not isinstance(self.rollover_from_date, Unset):
            rollover_from_date = self.rollover_from_date.isoformat()

        rollover_to_date: str | Unset = UNSET
        if not isinstance(self.rollover_to_date, Unset):
            rollover_to_date = self.rollover_to_date.isoformat()

        carryover_count = self.carryover_count

        policy_version = self.policy_version

        standard_minutes = self.standard_minutes

        premium_minutes = self.premium_minutes

        ocean_premium_minutes = self.ocean_premium_minutes

        ocean_family_minutes = self.ocean_family_minutes

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

        complaint_id: str | Unset = UNSET
        if not isinstance(self.complaint_id, Unset):
            complaint_id = str(self.complaint_id)

        source_complaint_decision_id: str | Unset = UNSET
        if not isinstance(self.source_complaint_decision_id, Unset):
            source_complaint_decision_id = str(self.source_complaint_decision_id)

        compensation_decision_id: str | Unset = UNSET
        if not isinstance(self.compensation_decision_id, Unset):
            compensation_decision_id = str(self.compensation_decision_id)

        rework_cleaning_target_id: str | Unset = UNSET
        if not isinstance(self.rework_cleaning_target_id, Unset):
            rework_cleaning_target_id = str(self.rework_cleaning_target_id)

        inspection_decision_id: str | Unset = UNSET
        if not isinstance(self.inspection_decision_id, Unset):
            inspection_decision_id = str(self.inspection_decision_id)

        same_maid = self.same_maid

        compensation_amount = self.compensation_amount

        amount = self.amount

        currency: str | Unset = UNSET
        if not isinstance(self.currency, Unset):
            currency = self.currency.value

        case_version = self.case_version

        payment_attempt_number = self.payment_attempt_number

        payment_method: str | Unset = UNSET
        if not isinstance(self.payment_method, Unset):
            payment_method = self.payment_method.value

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
        if previous_assignment_id is not UNSET:
            field_dict["previousAssignmentId"] = previous_assignment_id
        if previous_maid_profile_id is not UNSET:
            field_dict["previousMaidProfileId"] = previous_maid_profile_id
        if request_id is not UNSET:
            field_dict["requestId"] = request_id
        if decision is not UNSET:
            field_dict["decision"] = decision
        if reason_code is not UNSET:
            field_dict["reasonCode"] = reason_code
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
        if attempt_id is not UNSET:
            field_dict["attemptId"] = attempt_id
        if submission_id is not UNSET:
            field_dict["submissionId"] = submission_id
        if bomb_report_id is not UNSET:
            field_dict["bombReportId"] = bomb_report_id
        if earning_id is not UNSET:
            field_dict["earningId"] = earning_id
        if reclean_target_id is not UNSET:
            field_dict["recleanTargetId"] = reclean_target_id
        if evidence_count is not UNSET:
            field_dict["evidenceCount"] = evidence_count
        if photo_count is not UNSET:
            field_dict["photoCount"] = photo_count
        if current_revision is not UNSET:
            field_dict["currentRevision"] = current_revision
        if attempt_number is not UNSET:
            field_dict["attemptNumber"] = attempt_number
        if assignment_revision is not UNSET:
            field_dict["assignmentRevision"] = assignment_revision
        if execution_version is not UNSET:
            field_dict["executionVersion"] = execution_version
        if started_at is not UNSET:
            field_dict["startedAt"] = started_at
        if field_completed_at is not UNSET:
            field_dict["fieldCompletedAt"] = field_completed_at
        if ended_at is not UNSET:
            field_dict["endedAt"] = ended_at
        if capability_kind is not UNSET:
            field_dict["capabilityKind"] = capability_kind
        if expires_at is not UNSET:
            field_dict["expiresAt"] = expires_at
        if profile_status is not UNSET:
            field_dict["profileStatus"] = profile_status
        if profile_version is not UNSET:
            field_dict["profileVersion"] = profile_version
        if next_attempt_id is not UNSET:
            field_dict["nextAttemptId"] = next_attempt_id
        if target_slot_id is not UNSET:
            field_dict["targetSlotId"] = target_slot_id
        if photo_id is not UNSET:
            field_dict["photoId"] = photo_id
        if photo_version is not UNSET:
            field_dict["photoVersion"] = photo_version
        if uploaded_at is not UNSET:
            field_dict["uploadedAt"] = uploaded_at
        if purge_after is not UNSET:
            field_dict["purgeAfter"] = purge_after
        if offline_quarantine_id is not UNSET:
            field_dict["offlineQuarantineId"] = offline_quarantine_id
        if resolution is not UNSET:
            field_dict["resolution"] = resolution
        if rollover_from_date is not UNSET:
            field_dict["rolloverFromDate"] = rollover_from_date
        if rollover_to_date is not UNSET:
            field_dict["rolloverToDate"] = rollover_to_date
        if carryover_count is not UNSET:
            field_dict["carryoverCount"] = carryover_count
        if policy_version is not UNSET:
            field_dict["policyVersion"] = policy_version
        if standard_minutes is not UNSET:
            field_dict["standardMinutes"] = standard_minutes
        if premium_minutes is not UNSET:
            field_dict["premiumMinutes"] = premium_minutes
        if ocean_premium_minutes is not UNSET:
            field_dict["oceanPremiumMinutes"] = ocean_premium_minutes
        if ocean_family_minutes is not UNSET:
            field_dict["oceanFamilyMinutes"] = ocean_family_minutes
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
        if complaint_id is not UNSET:
            field_dict["complaintId"] = complaint_id
        if source_complaint_decision_id is not UNSET:
            field_dict["sourceComplaintDecisionId"] = source_complaint_decision_id
        if compensation_decision_id is not UNSET:
            field_dict["compensationDecisionId"] = compensation_decision_id
        if rework_cleaning_target_id is not UNSET:
            field_dict["reworkCleaningTargetId"] = rework_cleaning_target_id
        if inspection_decision_id is not UNSET:
            field_dict["inspectionDecisionId"] = inspection_decision_id
        if same_maid is not UNSET:
            field_dict["sameMaid"] = same_maid
        if compensation_amount is not UNSET:
            field_dict["compensationAmount"] = compensation_amount
        if amount is not UNSET:
            field_dict["amount"] = amount
        if currency is not UNSET:
            field_dict["currency"] = currency
        if case_version is not UNSET:
            field_dict["caseVersion"] = case_version
        if payment_attempt_number is not UNSET:
            field_dict["paymentAttemptNumber"] = payment_attempt_number
        if payment_method is not UNSET:
            field_dict["paymentMethod"] = payment_method

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

        _previous_assignment_id = d.pop("previousAssignmentId", UNSET)
        previous_assignment_id: UUID | Unset
        if isinstance(_previous_assignment_id, Unset):
            previous_assignment_id = UNSET
        else:
            previous_assignment_id = UUID(_previous_assignment_id)

        _previous_maid_profile_id = d.pop("previousMaidProfileId", UNSET)
        previous_maid_profile_id: UUID | Unset
        if isinstance(_previous_maid_profile_id, Unset):
            previous_maid_profile_id = UNSET
        else:
            previous_maid_profile_id = UUID(_previous_maid_profile_id)

        _request_id = d.pop("requestId", UNSET)
        request_id: UUID | Unset
        if isinstance(_request_id, Unset):
            request_id = UNSET
        else:
            request_id = UUID(_request_id)

        _decision = d.pop("decision", UNSET)
        decision: DeveloperAuditEventSummaryDecision | Unset
        if isinstance(_decision, Unset):
            decision = UNSET
        else:
            decision = DeveloperAuditEventSummaryDecision(_decision)

        reason_code = d.pop("reasonCode", UNSET)

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

        _attempt_id = d.pop("attemptId", UNSET)
        attempt_id: UUID | Unset
        if isinstance(_attempt_id, Unset):
            attempt_id = UNSET
        else:
            attempt_id = UUID(_attempt_id)

        _submission_id = d.pop("submissionId", UNSET)
        submission_id: UUID | Unset
        if isinstance(_submission_id, Unset):
            submission_id = UNSET
        else:
            submission_id = UUID(_submission_id)

        _bomb_report_id = d.pop("bombReportId", UNSET)
        bomb_report_id: UUID | Unset
        if isinstance(_bomb_report_id, Unset):
            bomb_report_id = UNSET
        else:
            bomb_report_id = UUID(_bomb_report_id)

        _earning_id = d.pop("earningId", UNSET)
        earning_id: UUID | Unset
        if isinstance(_earning_id, Unset):
            earning_id = UNSET
        else:
            earning_id = UUID(_earning_id)

        _reclean_target_id = d.pop("recleanTargetId", UNSET)
        reclean_target_id: UUID | Unset
        if isinstance(_reclean_target_id, Unset):
            reclean_target_id = UNSET
        else:
            reclean_target_id = UUID(_reclean_target_id)

        evidence_count = d.pop("evidenceCount", UNSET)

        photo_count = d.pop("photoCount", UNSET)

        current_revision = d.pop("currentRevision", UNSET)

        attempt_number = d.pop("attemptNumber", UNSET)

        assignment_revision = d.pop("assignmentRevision", UNSET)

        execution_version = d.pop("executionVersion", UNSET)

        _started_at = d.pop("startedAt", UNSET)
        started_at: datetime.datetime | Unset
        if isinstance(_started_at, Unset):
            started_at = UNSET
        else:
            started_at = datetime.datetime.fromisoformat(_started_at)

        _field_completed_at = d.pop("fieldCompletedAt", UNSET)
        field_completed_at: datetime.datetime | Unset
        if isinstance(_field_completed_at, Unset):
            field_completed_at = UNSET
        else:
            field_completed_at = datetime.datetime.fromisoformat(_field_completed_at)

        _ended_at = d.pop("endedAt", UNSET)
        ended_at: datetime.datetime | Unset
        if isinstance(_ended_at, Unset):
            ended_at = UNSET
        else:
            ended_at = datetime.datetime.fromisoformat(_ended_at)

        _capability_kind = d.pop("capabilityKind", UNSET)
        capability_kind: DeveloperAuditEventSummaryCapabilityKind | Unset
        if isinstance(_capability_kind, Unset):
            capability_kind = UNSET
        else:
            capability_kind = DeveloperAuditEventSummaryCapabilityKind(_capability_kind)

        _expires_at = d.pop("expiresAt", UNSET)
        expires_at: datetime.datetime | Unset
        if isinstance(_expires_at, Unset):
            expires_at = UNSET
        else:
            expires_at = datetime.datetime.fromisoformat(_expires_at)

        _profile_status = d.pop("profileStatus", UNSET)
        profile_status: DeveloperAuditEventSummaryProfileStatus | Unset
        if isinstance(_profile_status, Unset):
            profile_status = UNSET
        else:
            profile_status = DeveloperAuditEventSummaryProfileStatus(_profile_status)

        profile_version = d.pop("profileVersion", UNSET)

        _next_attempt_id = d.pop("nextAttemptId", UNSET)
        next_attempt_id: UUID | Unset
        if isinstance(_next_attempt_id, Unset):
            next_attempt_id = UNSET
        else:
            next_attempt_id = UUID(_next_attempt_id)

        _target_slot_id = d.pop("targetSlotId", UNSET)
        target_slot_id: UUID | Unset
        if isinstance(_target_slot_id, Unset):
            target_slot_id = UNSET
        else:
            target_slot_id = UUID(_target_slot_id)

        _photo_id = d.pop("photoId", UNSET)
        photo_id: UUID | Unset
        if isinstance(_photo_id, Unset):
            photo_id = UNSET
        else:
            photo_id = UUID(_photo_id)

        photo_version = d.pop("photoVersion", UNSET)

        _uploaded_at = d.pop("uploadedAt", UNSET)
        uploaded_at: datetime.datetime | Unset
        if isinstance(_uploaded_at, Unset):
            uploaded_at = UNSET
        else:
            uploaded_at = datetime.datetime.fromisoformat(_uploaded_at)

        _purge_after = d.pop("purgeAfter", UNSET)
        purge_after: datetime.datetime | Unset
        if isinstance(_purge_after, Unset):
            purge_after = UNSET
        else:
            purge_after = datetime.datetime.fromisoformat(_purge_after)

        _offline_quarantine_id = d.pop("offlineQuarantineId", UNSET)
        offline_quarantine_id: UUID | Unset
        if isinstance(_offline_quarantine_id, Unset):
            offline_quarantine_id = UNSET
        else:
            offline_quarantine_id = UUID(_offline_quarantine_id)

        _resolution = d.pop("resolution", UNSET)
        resolution: DeveloperAuditEventSummaryResolution | Unset
        if isinstance(_resolution, Unset):
            resolution = UNSET
        else:
            resolution = DeveloperAuditEventSummaryResolution(_resolution)

        _rollover_from_date = d.pop("rolloverFromDate", UNSET)
        rollover_from_date: datetime.date | Unset
        if isinstance(_rollover_from_date, Unset):
            rollover_from_date = UNSET
        else:
            rollover_from_date = datetime.date.fromisoformat(_rollover_from_date)

        _rollover_to_date = d.pop("rolloverToDate", UNSET)
        rollover_to_date: datetime.date | Unset
        if isinstance(_rollover_to_date, Unset):
            rollover_to_date = UNSET
        else:
            rollover_to_date = datetime.date.fromisoformat(_rollover_to_date)

        carryover_count = d.pop("carryoverCount", UNSET)

        policy_version = d.pop("policyVersion", UNSET)

        standard_minutes = d.pop("standardMinutes", UNSET)

        premium_minutes = d.pop("premiumMinutes", UNSET)

        ocean_premium_minutes = d.pop("oceanPremiumMinutes", UNSET)

        ocean_family_minutes = d.pop("oceanFamilyMinutes", UNSET)

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

        _complaint_id = d.pop("complaintId", UNSET)
        complaint_id: UUID | Unset
        if isinstance(_complaint_id, Unset):
            complaint_id = UNSET
        else:
            complaint_id = UUID(_complaint_id)

        _source_complaint_decision_id = d.pop("sourceComplaintDecisionId", UNSET)
        source_complaint_decision_id: UUID | Unset
        if isinstance(_source_complaint_decision_id, Unset):
            source_complaint_decision_id = UNSET
        else:
            source_complaint_decision_id = UUID(_source_complaint_decision_id)

        _compensation_decision_id = d.pop("compensationDecisionId", UNSET)
        compensation_decision_id: UUID | Unset
        if isinstance(_compensation_decision_id, Unset):
            compensation_decision_id = UNSET
        else:
            compensation_decision_id = UUID(_compensation_decision_id)

        _rework_cleaning_target_id = d.pop("reworkCleaningTargetId", UNSET)
        rework_cleaning_target_id: UUID | Unset
        if isinstance(_rework_cleaning_target_id, Unset):
            rework_cleaning_target_id = UNSET
        else:
            rework_cleaning_target_id = UUID(_rework_cleaning_target_id)

        _inspection_decision_id = d.pop("inspectionDecisionId", UNSET)
        inspection_decision_id: UUID | Unset
        if isinstance(_inspection_decision_id, Unset):
            inspection_decision_id = UNSET
        else:
            inspection_decision_id = UUID(_inspection_decision_id)

        same_maid = d.pop("sameMaid", UNSET)

        compensation_amount = d.pop("compensationAmount", UNSET)

        amount = d.pop("amount", UNSET)

        _currency = d.pop("currency", UNSET)
        currency: DeveloperAuditEventSummaryCurrency | Unset
        if isinstance(_currency, Unset):
            currency = UNSET
        else:
            currency = DeveloperAuditEventSummaryCurrency(_currency)

        case_version = d.pop("caseVersion", UNSET)

        payment_attempt_number = d.pop("paymentAttemptNumber", UNSET)

        _payment_method = d.pop("paymentMethod", UNSET)
        payment_method: DeveloperAuditEventSummaryPaymentMethod | Unset
        if isinstance(_payment_method, Unset):
            payment_method = UNSET
        else:
            payment_method = DeveloperAuditEventSummaryPaymentMethod(_payment_method)

        developer_audit_event_summary = cls(
            display_name=display_name,
            login_id=login_id,
            role=role,
            status=status,
            must_change_password=must_change_password,
            maid_profile_id=maid_profile_id,
            cleaning_target_id=cleaning_target_id,
            assignment_id=assignment_id,
            previous_assignment_id=previous_assignment_id,
            previous_maid_profile_id=previous_maid_profile_id,
            request_id=request_id,
            decision=decision,
            reason_code=reason_code,
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
            attempt_id=attempt_id,
            submission_id=submission_id,
            bomb_report_id=bomb_report_id,
            earning_id=earning_id,
            reclean_target_id=reclean_target_id,
            evidence_count=evidence_count,
            photo_count=photo_count,
            current_revision=current_revision,
            attempt_number=attempt_number,
            assignment_revision=assignment_revision,
            execution_version=execution_version,
            started_at=started_at,
            field_completed_at=field_completed_at,
            ended_at=ended_at,
            capability_kind=capability_kind,
            expires_at=expires_at,
            profile_status=profile_status,
            profile_version=profile_version,
            next_attempt_id=next_attempt_id,
            target_slot_id=target_slot_id,
            photo_id=photo_id,
            photo_version=photo_version,
            uploaded_at=uploaded_at,
            purge_after=purge_after,
            offline_quarantine_id=offline_quarantine_id,
            resolution=resolution,
            rollover_from_date=rollover_from_date,
            rollover_to_date=rollover_to_date,
            carryover_count=carryover_count,
            policy_version=policy_version,
            standard_minutes=standard_minutes,
            premium_minutes=premium_minutes,
            ocean_premium_minutes=ocean_premium_minutes,
            ocean_family_minutes=ocean_family_minutes,
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
            complaint_id=complaint_id,
            source_complaint_decision_id=source_complaint_decision_id,
            compensation_decision_id=compensation_decision_id,
            rework_cleaning_target_id=rework_cleaning_target_id,
            inspection_decision_id=inspection_decision_id,
            same_maid=same_maid,
            compensation_amount=compensation_amount,
            amount=amount,
            currency=currency,
            case_version=case_version,
            payment_attempt_number=payment_attempt_number,
            payment_method=payment_method,
        )

        return developer_audit_event_summary
