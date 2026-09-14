from enum import Enum


class DeveloperAuditEventSummaryCheckoutDecision(str, Enum):
    CONFIRM_DEPARTED = "CONFIRM_DEPARTED"
    EXTEND_CHECKOUT = "EXTEND_CHECKOUT"
    FALSE_REPORT = "FALSE_REPORT"

    def __str__(self) -> str:
        return str(self.value)
