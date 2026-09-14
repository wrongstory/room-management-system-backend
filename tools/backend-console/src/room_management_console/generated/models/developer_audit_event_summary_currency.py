from enum import Enum


class DeveloperAuditEventSummaryCurrency(str, Enum):
    KRW = "KRW"

    def __str__(self) -> str:
        return str(self.value)
