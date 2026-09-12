from enum import Enum


class RoomPinSheetSyncStatusStatus(str, Enum):
    AWAITING_FIRST_RUN = "awaiting_first_run"
    DEGRADED = "degraded"
    FAILED = "failed"
    HEALTHY = "healthy"
    OPERATOR_BLOCKED = "operator_blocked"

    def __str__(self) -> str:
        return str(self.value)
