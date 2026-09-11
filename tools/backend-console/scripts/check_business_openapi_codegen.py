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
    if not isinstance(paths, dict) or len(paths) != 97:
        raise RuntimeError("전체 source OpenAPI path 수가 97이 아닙니다.")
    methods = {"get", "post", "put", "patch", "delete"}
    operation_count = sum(
        1
        for path_item in paths.values()
        if isinstance(path_item, dict)
        for method in path_item
        if method in methods
    )
    if operation_count != 104:
        raise RuntimeError("전체 source OpenAPI operation 수가 104가 아닙니다.")
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
            package / "api" / "push_subscriptions" / "register_web_push_subscription.py",
            package / "api" / "push_subscriptions" / "retire_web_push_subscription.py",
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
        ]
        missing = [str(path.relative_to(destination)) for path in required if not path.is_file()]
        if missing:
            raise RuntimeError(f"업무 Python codegen 결과가 누락됐습니다: {', '.join(missing)}")
        if not compileall.compile_dir(package, quiet=1):
            raise RuntimeError("업무 Python codegen 결과를 컴파일할 수 없습니다.")

    print("full OpenAPI push/payroll/complaint Python ephemeral codegen PASS")


if __name__ == "__main__":
    main()
