from enum import Enum


class DeveloperAuditEventSummaryPaymentMethod(str, Enum):
    BANK_TRANSFER = "bank_transfer"

    def __str__(self) -> str:
        return str(self.value)
