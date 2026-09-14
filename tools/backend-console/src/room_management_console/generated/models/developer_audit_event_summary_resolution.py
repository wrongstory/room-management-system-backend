from enum import Enum


class DeveloperAuditEventSummaryResolution(str, Enum):
    CORRECTION_LINK = "correction_link"
    RECORD_ONLY = "record_only"
    REJECT_EFFECT = "reject_effect"

    def __str__(self) -> str:
        return str(self.value)
