from __future__ import annotations

import compileall
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ENUM_VALUE_PATTERN = re.compile(r'^\s+[A-Z][A-Z0-9_]+ = "([^"]+)"$', re.MULTILINE)


def generated_enum_values(path: Path) -> list[str]:
    return ENUM_VALUE_PATTERN.findall(path.read_text(encoding="utf-8"))


def main() -> None:
    console_root = Path(__file__).resolve().parents[1]
    repository_root = console_root.parents[1]
    npm = shutil.which("npm")
    uv = shutil.which("uv")
    if not npm or not uv:
        raise RuntimeError("npm과 uv 실행 파일이 PATH에 필요합니다.")

    subprocess.run(  # noqa: S603
        [npm, "run", "openapi:export:full"],
        cwd=repository_root,
        check=True,
    )
    source = repository_root / ".tmp" / "full-openapi.json"
    document = json.loads(source.read_text(encoding="utf-8"))
    if document.get("info", {}).get("version") != "0.6.0":
        raise RuntimeError("전체 source OpenAPI version이 0.6.0이 아닙니다.")
    paths = document.get("paths")
    if not isinstance(paths, dict) or len(paths) != 134:
        raise RuntimeError("전체 source OpenAPI path 수가 134이 아닙니다.")
    methods = {"get", "post", "put", "patch", "delete"}
    operation_count = sum(
        1
        for path_item in paths.values()
        if isinstance(path_item, dict)
        for method in path_item
        if method in methods
    )
    if operation_count != 144:
        raise RuntimeError("전체 source OpenAPI operation 수가 144이 아닙니다.")
    schemas = document.get("components", {}).get("schemas", {})
    adjustment_book = schemas.get("PayrollAdjustmentBook", {})
    book_fields = ["maidProfileId", "weekStart", "currentBookVersion"]
    if (
        adjustment_book.get("required") != book_fields
        or list(adjustment_book.get("properties", {})) != book_fields
        or adjustment_book.get("additionalProperties") is not False
        or adjustment_book.get("properties", {}).get("currentBookVersion", {}).get("type")
        != "integer"
        or adjustment_book.get("properties", {}).get("currentBookVersion", {}).get("minimum") != 0
        or adjustment_book.get("properties", {}).get("currentBookVersion", {}).get("maximum")
        != 9007199254740991
    ):
        raise RuntimeError("최신 주급 조정 원장의 필수 필드/safe integer 계약이 잘못됐습니다.")
    book_operation = paths.get("/v1/payroll/adjustment-book", {}).get("get", {})
    if (
        book_operation.get("operationId") != "getPayrollAdjustmentBook"
        or book_operation.get("x-required-roles") != ["admin"]
        or [
            (parameter.get("name"), parameter.get("in"), parameter.get("required"))
            for parameter in book_operation.get("parameters", [])
        ]
        != [("maidProfileId", "query", True), ("weekStart", "query", True)]
    ):
        raise RuntimeError("최신 주급 조정 원장의 관리자 조회/query 계약이 누락됐습니다.")
    menu = (
        schemas.get("CheckoutIncidentListItem", {})
        .get("properties", {})
        .get("allowedDecisions", {})
    )
    if [item.get("enum") for item in menu.get("prefixItems", [])] != [
        ["EXTEND_CHECKOUT"],
        ["CONFIRM_DEPARTED"],
        ["FALSE_REPORT"],
    ]:
        raise RuntimeError("미퇴실 목록 결정 메뉴 순서의 머신 계약이 누락됐습니다.")
    audit_event_types = schemas.get("DeveloperAuditEventType", {}).get("enum")
    if (
        not isinstance(audit_event_types, list)
        or len(audit_event_types) != 74
        or len(set(audit_event_types)) != 74
    ):
        raise RuntimeError("developer 감사 이벤트 OpenAPI inventory가 74종이 아닙니다.")
    legacy_list = schemas.get("ReservationListEnvelope", {})
    range_page = schemas.get("ReservationRangePageEnvelope", {})
    legacy_reservations = legacy_list.get("properties", {}).get("reservations", {})
    range_reservations = range_page.get("properties", {}).get("reservations", {})
    if "maxItems" in legacy_reservations:
        raise RuntimeError("legacy 예약 목록에 range page 크기 제한이 적용됐습니다.")
    if range_reservations.get("maxItems") != 50:
        raise RuntimeError("예약 범위 page의 50건 제한이 누락됐습니다.")
    if range_page.get("required") != ["reservations", "nextCursor", "serverTime"]:
        raise RuntimeError("예약 범위 page의 필수 envelope 필드가 올바르지 않습니다.")
    with tempfile.TemporaryDirectory(prefix="business-openapi-codegen-") as temporary:
        destination = Path(temporary) / "generated-project"
        subprocess.run(  # noqa: S603
            [
                uv,
                "run",
                "--python",
                "3.12",
                "openapi-python-client",
                "generate",
                "--path",
                str(source),
                "--config",
                str(console_root / "openapi-python-client.yaml"),
                "--output-path",
                str(destination),
                "--overwrite",
            ],
            cwd=console_root,
            check=True,
        )
        package = destination / "generated"
        required = [
            package / "api" / "assignments" / "list_assignments.py",
            package / "api" / "assignments" / "get_assignment_history.py",
            package / "models" / "assignment_card.py",
            package / "models" / "assignment_schedule_snapshot.py",
            package / "models" / "assignment_current_departure.py",
            package / "models" / "assignment_preview_diagnostics.py",
            package / "models" / "assignment_preview_remaining_target.py",
            package / "api" / "reservations" / "list_reservations.py",
            package / "api" / "reservations" / "preview_reservation_bookability.py",
            package / "models" / "reservation_list_envelope.py",
            package / "models" / "reservation_range_page_envelope.py",
            package / "models" / "reservation_bookability_standard_preview_request.py",
            package / "models" / "reservation_bookability_long_stay_preview_request.py",
            package / "models" / "reservation_standard_create_request.py",
            package / "models" / "reservation_long_stay_create_request.py",
            package / "models" / "reservation_standard_change_request.py",
            package / "models" / "reservation_long_stay_change_request.py",
            package / "models" / "reservation_bookability_candidate.py",
            package / "models" / "reservation_bookability_preview.py",
            package / "models" / "reservation_bookability_preview_envelope.py",
            package / "api" / "reservations" / "preview_reservation_room_move.py",
            package / "api" / "reservations" / "commit_reservation_room_move.py",
            package / "models" / "reservation_room_move_preview_request.py",
            package / "models" / "reservation_room_move_commit_request.py",
            package / "models" / "reservation_room_move_preview.py",
            package / "models" / "reservation_room_move_result.py",
            package / "models" / "reservation_room_move_stay.py",
            package / "models" / "reservation_room_move_segment.py",
            package / "api" / "cleaning_templates" / "list_cleaning_templates.py",
            package / "api" / "cleaning_templates" / "publish_cleaning_template.py",
            package / "api" / "cleaning_history" / "list_cleaning_history.py",
            package / "models" / "cleaning_history_item.py",
            package / "models" / "cleaning_history_page.py",
            package / "models" / "cleaning_template_catalog.py",
            package / "models" / "cleaning_template_room_type_state.py",
            package / "models" / "cleaning_template_slot.py",
            package / "models" / "publish_cleaning_template_request.py",
            package / "models" / "published_cleaning_template.py",
            package / "api" / "checkout_incidents" / "report_checkout_not_completed.py",
            package / "api" / "checkout_incidents" / "get_checkout_incident.py",
            package / "api" / "checkout_incidents" / "list_checkout_incidents.py",
            package / "models" / "checkout_incident_list_item.py",
            package / "models" / "checkout_incident_list_envelope.py",
            package / "api" / "checkout_incidents" / "decide_checkout_incident.py",
            package / "models" / "checkout_incident.py",
            package / "models" / "checkout_incident_decision.py",
            package / "models" / "checkout_incident_decision_request.py",
            package / "models" / "checkout_incident_envelope.py",
            package / "models" / "checkout_incident_reassignment.py",
            package / "models" / "checkout_incident_report_request.py",
            package / "api" / "push_subscriptions" / "register_web_push_subscription.py",
            package / "api" / "push_subscriptions" / "retire_web_push_subscription.py",
            package / "api" / "push_subscriptions" / "get_web_push_subscription_config.py",
            package / "models" / "web_push_subscription.py",
            package / "models" / "web_push_subscription_envelope.py",
            package / "models" / "web_push_subscription_register_request.py",
            package / "models" / "web_push_subscription_retire_request.py",
            package / "api" / "notifications" / "list_notifications.py",
            package / "api" / "notifications" / "mark_notification_read.py",
            package / "models" / "notification.py",
            package / "models" / "notification_envelope.py",
            package / "models" / "notification_list_envelope.py",
            package / "api" / "payroll" / "list_payroll_cycles.py",
            package / "api" / "payroll" / "get_payroll_cycle.py",
            package / "api" / "payroll" / "list_payroll_entries.py",
            package / "api" / "payroll" / "get_payroll_adjustment_book.py",
            package / "api" / "payroll" / "list_payroll_work_details.py",
            package / "models" / "payroll_work_details_envelope.py",
            package / "models" / "payroll_work_summary.py",
            package / "models" / "payroll_work_earning.py",
            package / "models" / "payroll_work_workflow.py",
            package / "models" / "payroll_adjustment_book.py",
            package / "models" / "payroll_adjustment_book_envelope.py",
            package / "api" / "payroll" / "start_payroll_cycle.py",
            package / "api" / "payroll" / "record_payroll_correction.py",
            package / "api" / "payroll" / "reverse_payroll_source.py",
            package / "api" / "payroll" / "carry_forward_payroll_cycle.py",
            package / "api" / "payroll" / "carry_late_payroll_earning.py",
            package / "api" / "payroll" / "record_payroll_payment_check.py",
            package / "api" / "payroll" / "record_payroll_payment_paid.py",
            package / "api" / "payroll" / "reopen_payroll_payment_attempt.py",
            package / "models" / "payroll_cycle.py",
            package / "models" / "payroll_item.py",
            package / "models" / "payroll_late_earning.py",
            package / "models" / "payroll_entries_envelope.py",
            package / "models" / "payroll_start_request.py",
            package / "models" / "payroll_status.py",
            package / "models" / "payroll_adjustment.py",
            package / "models" / "payroll_adjustment_entry.py",
            package / "models" / "payroll_adjustment_reason.py",
            package / "models" / "payroll_earning_correction_request.py",
            package / "models" / "payroll_adjustment_correction_request.py",
            package / "models" / "payroll_earning_reversal_request.py",
            package / "models" / "payroll_adjustment_reversal_request.py",
            package / "models" / "payroll_late_carry_request.py",
            package / "models" / "payroll_payment_check_request.py",
            package / "models" / "payroll_payment_paid_request.py",
            package / "models" / "payroll_payment_reopen_request.py",
            package / "models" / "payroll_payment_result.py",
            package / "models" / "payroll_payment_result_envelope.py",
            package / "api" / "complaints" / "list_complaints.py",
            package / "api" / "complaints" / "create_complaint.py",
            package / "api" / "complaints" / "get_complaint.py",
            package / "api" / "complaints" / "list_complaint_history.py",
            package / "api" / "complaints" / "start_complaint_review.py",
            package / "api" / "complaints" / "decide_complaint.py",
            package / "api" / "complaints" / "respond_complaint.py",
            package / "api" / "complaints" / "correct_complaint_decision.py",
            package / "api" / "complaints" / "close_complaint.py",
            package / "api" / "complaints" / "materialize_complaint_rework.py",
            package / "models" / "complaint.py",
            package / "models" / "complaint_decision.py",
            package / "models" / "complaint_history_event.py",
            package / "models" / "complaint_maid_response.py",
            package / "models" / "complaint_rework_decision_type_0.py",
            package / "models" / "complaint_rework_decision_type_1.py",
            package / "models" / "complaint_rework_decision_type_2.py",
            package / "models" / "complaint_rework_request.py",
            package / "models" / "complaint_rework_envelope.py",
            package / "models" / "complaint_rework_envelope_assignment.py",
            package / "api" / "rooms" / "prepare_room_pin_change.py",
            package / "api" / "rooms" / "confirm_room_pin_change.py",
            package / "api" / "rooms" / "rollback_room_pin_change.py",
            package / "api" / "rooms" / "reveal_room_pin.py",
            package / "api" / "rooms" / "confirm_generated_room_pin.py",
            package / "api" / "rooms" / "get_room_pin_sheet_sync_status.py",
            package / "api" / "rooms" / "request_room_pin_sheet_full_resync.py",
            package / "api" / "rooms" / "list_room_events.py",
            package / "models" / "room_event.py",
            package / "models" / "room_event_category.py",
            package / "models" / "room_event_source.py",
            package / "models" / "room_event_summary.py",
            package / "models" / "room_event_type.py",
            package / "models" / "room_events_envelope.py",
            package / "models" / "room_pin_change_prepare_request.py",
            package / "models" / "room_pin_reveal.py",
            package / "models" / "generated_room_pin_confirm_request.py",
            package / "models" / "generated_room_pin_confirmation.py",
            package / "models" / "generated_room_pin_confirmation_envelope.py",
            package / "models" / "room_pin_sheet_operator_status.py",
            package / "models" / "room_pin_sheet_full_resync_request.py",
            package / "models" / "room_pin_sheet_full_resync_accepted.py",
            package / "api" / "developer" / "get_developer_room_catalog.py",
            package / "api" / "developer" / "preview_developer_room_type_capacity.py",
            package / "api" / "developer" / "change_developer_room_type_capacity.py",
            package / "api" / "developer" / "create_developer_room.py",
            package / "api" / "developer" / "preview_developer_room_deactivation.py",
            package / "api" / "developer" / "deactivate_developer_room.py",
            package / "models" / "developer_room_catalog.py",
            package / "models" / "developer_room_catalog_item.py",
            package / "models" / "developer_room_catalog_summary.py",
            package / "models" / "developer_room_type_catalog_item.py",
            package / "models" / "developer_room_type_capacity_preview_request.py",
            package / "models" / "developer_room_type_capacity_change_request.py",
            package / "models" / "developer_room_type_capacity_preview.py",
            package / "models" / "developer_room_type_capacity_change.py",
            package / "models" / "developer_room_create_request.py",
            package / "models" / "developer_room_deactivation_preview_request.py",
            package / "models" / "developer_room_deactivation_request.py",
            package / "models" / "developer_room_deactivation_preview.py",
            package / "models" / "developer_room_mutation_result.py",
            package / "models" / "developer_audit_event_type.py",
            package / "models" / "developer_audit_event_summary.py",
            package / "api" / "assignments" / "cancel_unavailable_cleaning_assignment.py",
            package / "models" / "assignment_unavailability_cancellation_request.py",
            package / "models" / "assignment_unavailability_cancellation.py",
        ]
        missing = [str(path.relative_to(destination)) for path in required if not path.is_file()]
        if missing:
            raise RuntimeError(f"업무 Python codegen 결과가 누락됐습니다: {', '.join(missing)}")
        for book_model_name, book_expected_fields in (
            (
                "payroll_adjustment_book",
                {
                    "maid_profile_id": "UUID",
                    "week_start": "datetime.date",
                    "current_book_version": "int",
                },
            ),
            ("payroll_adjustment_book_envelope", {"adjustment_book": "PayrollAdjustmentBook"}),
        ):
            model = (package / "models" / f"{book_model_name}.py").read_text(encoding="utf-8")
            for field, expected_type in book_expected_fields.items():
                declaration = re.search(rf"^\s+{field}:\s+([^\r\n=]+)", model, re.MULTILINE)
                if declaration is None or declaration.group(1).strip() != expected_type:
                    raise RuntimeError(f"주급 조정 원장 codegen 필수 타입 불일치: {field}")
            for forbidden in ("session_id:", "book_id:", "book_version:", "pin:", "request_hash:"):
                if re.search(rf"^\s+{re.escape(forbidden)}", model, re.MULTILINE):
                    raise RuntimeError(f"주급 조정 원장 codegen 비공개 필드 노출: {forbidden}")
        book_api = (package / "api" / "payroll" / "get_payroll_adjustment_book.py").read_text(
            encoding="utf-8"
        )
        for field in ("maid_profile_id: UUID", "week_start: datetime.date"):
            if field not in book_api or f"{field} | Unset" in book_api:
                raise RuntimeError(f"주급 조정 원장 codegen 필수 query 불일치: {field}")
        if '"/v1/payroll/adjustment-book"' not in book_api:
            raise RuntimeError("주급 조정 원장 codegen 정확한 조회 URL이 누락됐습니다.")
        work_api = (package / "api" / "payroll" / "list_payroll_work_details.py").read_text(
            encoding="utf-8"
        )
        for field in ("maid_profile_id: UUID", "week_start: datetime.date", "kind:"):
            if field not in work_api:
                raise RuntimeError(f"주급 산출 상세 codegen 필수 query가 누락됐습니다: {field}")
        if '"/v1/payroll/work-details"' not in work_api:
            raise RuntimeError("주급 산출 상세 codegen 정확한 URL이 누락됐습니다.")
        for model_name, required_fields in (
            (
                "payroll_work_details_envelope",
                ("week_start", "maid_profile_id", "kind", "summary", "entries", "next_cursor"),
            ),
            (
                "payroll_work_earning",
                (
                    "earning_id",
                    "earned_on",
                    "base_amount",
                    "bomb_room_bonus",
                    "total_amount",
                    "room_number",
                    "room_type_code",
                    "room_type_name",
                ),
            ),
            (
                "payroll_work_workflow",
                (
                    "earning_id",
                    "base_amount",
                    "bomb_room_bonus",
                    "total_amount",
                    "expected_base_contribution_amount",
                    "expected_bomb_contribution_amount",
                    "pending_contribution_amount",
                    "included_in_pending_count",
                ),
            ),
            (
                "payroll_work_summary",
                (
                    "cycle_id",
                    "cycle_status",
                    "cycle_version",
                    "accrual_amount",
                    "expected_amount",
                    "pending_amount",
                    "locked_amount",
                    "offset_settled",
                    "payable_amount",
                ),
            ),
        ):
            model = (package / "models" / f"{model_name}.py").read_text(encoding="utf-8")
            for field in required_fields:
                declaration = re.search(rf"^\s+{field}:\s+([^\r\n=]+)", model, re.MULTILINE)
                if declaration is None or "Unset" in declaration.group(1):
                    raise RuntimeError(
                        f"주급 산출 상세 required nullable codegen 필드 불일치: {field}"
                    )
        # #328 required nullable fields must not become optional Unset fields
        # or lose the distinct plan/current types during actual client generation.
        for model_name, expected_fields in (
            (
                "assignment_card",
                {
                    "schedule_snapshot": {"AssignmentScheduleSnapshot", "None"},
                    "current_departure": {"AssignmentCurrentDeparture", "None"},
                },
            ),
            (
                "assignment_schedule_snapshot",
                {
                    "captured_at": {"datetime.datetime"},
                    "schedule_revision": {"int"},
                    "schedule_reason_code": {"str"},
                    "source_reservation_version": {"int", "None"},
                    "planned_checkout_at": {"datetime.datetime", "None"},
                    "actual_checkout_at": {"datetime.datetime", "None"},
                    "planned_room_departure_at": {"datetime.datetime", "None"},
                    "actual_room_departure_at": {"datetime.datetime", "None"},
                    "next_check_in_at": {"datetime.datetime", "None"},
                    "next_room_arrival_at": {"datetime.datetime", "None"},
                    "is_early_check_in": {"bool", "None"},
                    "is_late_checkout": {"bool", "None"},
                    "is_schedule_updated": {"bool"},
                },
            ),
            (
                "assignment_current_departure",
                {
                    "evaluated_at": {"datetime.datetime"},
                    "actual_checkout_at": {"datetime.datetime", "None"},
                    "actual_room_departure_at": {"datetime.datetime", "None"},
                },
            ),
        ):
            generated_model = (package / "models" / f"{model_name}.py").read_text(encoding="utf-8")
            for field, expected_types in expected_fields.items():
                declaration = re.search(
                    rf"^\s+{field}:\s+([^\r\n=]+)", generated_model, re.MULTILINE
                )
                if (
                    declaration is None
                    or {part.strip() for part in declaration.group(1).split("|")} != expected_types
                ):
                    raise RuntimeError(f"배정 일정 codegen 필수 nullable 타입 불일치: {field}")
        incident_item = (package / "models" / "checkout_incident_list_item.py").read_text(
            encoding="utf-8"
        )
        for field in (
            "incident_id: UUID",
            "room_id: UUID",
            "room_number: str",
            "cleaning_target_id: UUID",
            "assignment_id: UUID",
            "attempt_id: UUID",
            "reported_at: datetime.datetime",
            "service_date: datetime.date",
            "status:",
            "allowed_decisions:",
        ):
            if field not in incident_item:
                raise RuntimeError(f"미퇴실 목록 codegen 필수 필드 누락: {field}")
        for field in ("reservation_id:", "reported_by:", "version:", "impact_fingerprint:"):
            if field in incident_item:
                raise RuntimeError(f"미퇴실 목록 codegen에 상세 전용 필드 노출: {field}")
        incident_envelope = (package / "models" / "checkout_incident_list_envelope.py").read_text(
            encoding="utf-8"
        )
        if (
            "items: list[CheckoutIncidentListItem]" not in incident_envelope
            or "next_cursor: None | str" not in incident_envelope
        ):
            raise RuntimeError("미퇴실 목록 codegen의 필수 items/nullable cursor 불일치")
        incident_api = (
            package / "api" / "checkout_incidents" / "list_checkout_incidents.py"
        ).read_text(encoding="utf-8")
        for field in ("room_id:", "cleaning_target_id:", "service_date:", "limit:", "cursor:"):
            if field not in incident_api:
                raise RuntimeError(f"미퇴실 목록 codegen query 필드 누락: {field}")
        room_event_model = (package / "models" / "room_event.py").read_text(encoding="utf-8")
        for field in (
            "event_key: str",
            "category: RoomEventCategory",
            "actor_profile_id: None | UUID",
            "actor_display_name: None | str",
            "entity_id: UUID",
        ):
            if field not in room_event_model:
                raise RuntimeError(f"객실 이벤트 codegen 필드가 누락됐습니다: {field}")
        room_event_api = (package / "api" / "rooms" / "list_room_events.py").read_text(
            encoding="utf-8"
        )
        if 'limit: str | Unset = "30"' not in room_event_api:
            raise RuntimeError("객실 이벤트 limit의 canonical decimal codegen 계약이 누락됐습니다.")
        prepare_model = (package / "models" / "room_pin_change_prepare_request.py").read_text(
            encoding="utf-8"
        )
        reveal_model = (package / "models" / "room_pin_reveal.py").read_text(encoding="utf-8")
        if "pin_digits: str" not in prepare_model or '"pinDigits": pin_digits' not in prepare_model:
            raise RuntimeError("PIN prepare codegen request에 pinDigits가 누락됐습니다.")
        if "credential: str" not in reveal_model or '"credential": credential' not in reveal_model:
            raise RuntimeError("PIN reveal codegen response에 credential이 누락됐습니다.")
        room_move_preview_path = package / "models" / "reservation_room_move_preview.py"
        room_move_preview_model = room_move_preview_path.read_text(encoding="utf-8")
        room_move_result_model = (package / "models" / "reservation_room_move_result.py").read_text(
            encoding="utf-8"
        )
        for field in (
            "stay_id: UUID",
            "stay_version: int",
            "source_segment_id: UUID",
            "source_segment_version: int",
        ):
            if field not in room_move_preview_model:
                raise RuntimeError(f"객실 변경 preview codegen 필드가 누락됐습니다: {field}")
        for field in (
            "stay: ReservationRoomMoveStay | Unset",
            "segments: list[ReservationRoomMoveSegment] | Unset",
            "source_cleaning_target_id: UUID | Unset",
            "pin_access_ends_at: datetime.datetime | Unset",
        ):
            if field not in room_move_result_model:
                raise RuntimeError(f"투숙 중 객실 변경 result codegen 필드가 누락됐습니다: {field}")
        bookability_candidate = (
            package / "models" / "reservation_bookability_candidate.py"
        ).read_text(encoding="utf-8")
        standard_bookability_request = (
            package / "models" / "reservation_bookability_standard_preview_request.py"
        ).read_text(encoding="utf-8")
        long_stay_bookability_request = (
            package / "models" / "reservation_bookability_long_stay_preview_request.py"
        ).read_text(encoding="utf-8")
        if 'reservation_type: Literal["standard"]' not in standard_bookability_request:
            raise RuntimeError("예약 가능성 standard request의 reservationType이 누락됐습니다.")
        if "check_out_at: datetime.datetime" not in standard_bookability_request:
            raise RuntimeError("예약 가능성 standard request의 필수 checkout이 누락됐습니다.")
        if 'reservation_type: Literal["long_stay"]' not in long_stay_bookability_request:
            raise RuntimeError("예약 가능성 long-stay request의 reservationType이 누락됐습니다.")
        if "check_out_at: datetime.datetime | None" not in long_stay_bookability_request:
            raise RuntimeError("예약 가능성 long-stay request의 nullable checkout이 누락됐습니다.")
        for request_model in (standard_bookability_request, long_stay_bookability_request):
            if "check_in_at: datetime.datetime" not in request_model:
                raise RuntimeError("예약 가능성 request의 checkInAt이 누락됐습니다.")
            guest_count = re.search(r"^\s+guest_count:\s+([^\r\n=]+)", request_model, re.MULTILINE)
            if guest_count is None or {
                part.strip() for part in guest_count.group(1).split("|")
            } != {"int", "None", "Unset"}:
                raise RuntimeError(
                    "예약 가능성 request의 guestCount가 optional nullable 계약이 아닙니다."
                )
            if "room_type_ids: list[UUID] | Unset" not in request_model:
                raise RuntimeError("예약 가능성 request의 optional roomTypeIds가 누락됐습니다.")
            if not all(
                token in request_model
                for token in ("exclude_reservation_id:", "UUID", "None", "Unset")
            ):
                raise RuntimeError(
                    "예약 가능성 request의 nullable excludeReservationId가 누락됐습니다."
                )
        for field in (
            "room_id: UUID",
            "room_number: str",
            "room_type_id: UUID",
            "room_state_version: int",
            "interval_bookable: bool",
            "check_in_ready: bool",
            "reason_codes: list[ReservationBookabilityReasonCode]",
            "evaluated_at: datetime.datetime",
        ):
            if field not in bookability_candidate:
                raise RuntimeError(f"예약 가능성 candidate codegen 필드가 누락됐습니다: {field}")
        reservation_list = (package / "models" / "reservation_list_envelope.py").read_text(
            encoding="utf-8"
        )
        reservation_range_page = (
            package / "models" / "reservation_range_page_envelope.py"
        ).read_text(encoding="utf-8")
        if "server_time" in reservation_list or "next_cursor" in reservation_list:
            raise RuntimeError("legacy 예약 목록 codegen에 range 필드가 섞였습니다.")
        if "server_time: datetime.datetime" not in reservation_range_page:
            raise RuntimeError("예약 범위 조회 codegen serverTime이 누락됐습니다.")
        if "next_cursor: None | str" not in reservation_range_page:
            raise RuntimeError("예약 범위 조회 codegen nextCursor가 누락됐습니다.")
        developer_room_type = (
            package / "models" / "developer_room_type_catalog_item.py"
        ).read_text(encoding="utf-8")
        for field in ("base_occupancy: int", "max_occupancy: int", "version: int"):
            if field not in developer_room_type:
                raise RuntimeError(f"개발자 객실 유형 codegen 필드가 누락됐습니다: {field}")
        generated_audit_type = package / "models" / "developer_audit_event_type.py"
        checked_in_package = console_root / "src" / "room_management_console" / "generated"
        checked_in_audit_type = checked_in_package / "models" / "developer_audit_event_type.py"
        expected_audit_types = set(audit_event_types)
        for label, path in (
            ("ephemeral", generated_audit_type),
            ("checked-in", checked_in_audit_type),
        ):
            actual = generated_enum_values(path)
            if len(actual) != 74 or set(actual) != expected_audit_types:
                raise RuntimeError(
                    f"{label} developer 감사 이벤트 생성물이 source 74종과 다릅니다."
                )
        for label, summary_path in (
            (
                "ephemeral",
                package / "models" / "developer_audit_event_summary.py",
            ),
            (
                "checked-in",
                checked_in_package / "models" / "developer_audit_event_summary.py",
            ),
        ):
            generated_summary = summary_path.read_text(encoding="utf-8")
            for field in (
                "occupied: bool | Unset",
                "display_status_override: None | RoomPrimaryDisplayStatus | Unset",
                "room_state_version: int | Unset",
                "replacement_target_id: UUID | Unset",
            ):
                if field not in generated_summary:
                    raise RuntimeError(
                        f"{label} developer 감사 safe summary 필드가 누락됐습니다: {field}"
                    )
        if not compileall.compile_dir(package, quiet=1):
            raise RuntimeError("업무 Python codegen 결과를 컴파일할 수 없습니다.")

    print("full OpenAPI reservation/push/payroll/complaint/room-PIN Python ephemeral codegen PASS")


if __name__ == "__main__":
    main()
