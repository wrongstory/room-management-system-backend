from enum import Enum


class DeveloperAuditEventSummaryCapabilityKind(str, Enum):
    EVIDENCE_UPLOAD = "evidence_upload"
    FINISH_CURRENT = "finish_current"
    UPLOAD_SUBMIT = "upload_submit"

    def __str__(self) -> str:
        return str(self.value)
