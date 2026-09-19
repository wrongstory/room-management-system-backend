from __future__ import annotations

import compileall
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


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
    paths = document.get("paths")
    if not isinstance(paths, dict) or len(paths) != 116:
        raise RuntimeError("전체 source OpenAPI path 수가 116이 아닙니다.")
    methods = {"get", "post", "put", "patch", "delete"}
    operation_count = sum(
        1
        for path_item in paths.values()
        if isinstance(path_item, dict)
        for method in path_item
        if method in methods
    )
    if operation_count != 124:
        raise RuntimeError("전체 source OpenAPI operation 수가 124가 아닙니다.")
    schemas = document.get("components", {}).get("schemas", {})
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
            package / "api" / "payroll" / "list_payroll_entries.py",
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
            package / "api" / "rooms" / "get_room_pin_sheet_sync_status.py",
            package / "api" / "rooms" / "request_room_pin_sheet_full_resync.py",
            package / "models" / "room_pin_change_prepare_request.py",
            package / "models" / "room_pin_reveal.py",
            package / "models" / "room_pin_sheet_operator_status.py",
            package / "models" / "room_pin_sheet_full_resync_request.py",
            package / "models" / "room_pin_sheet_full_resync_accepted.py",
        ]
        missing = [str(path.relative_to(destination)) for path in required if not path.is_file()]
        if missing:
            raise RuntimeError(f"업무 Python codegen 결과가 누락됐습니다: {', '.join(missing)}")
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
        if not compileall.compile_dir(package, quiet=1):
            raise RuntimeError("업무 Python codegen 결과를 컴파일할 수 없습니다.")

    print("full OpenAPI reservation/push/payroll/complaint/room-PIN Python ephemeral codegen PASS")


if __name__ == "__main__":
    main()
