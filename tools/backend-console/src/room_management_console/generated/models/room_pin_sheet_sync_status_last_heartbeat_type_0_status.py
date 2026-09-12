from enum import Enum


class RoomPinSheetSyncStatusLastHeartbeatType0Status(str, Enum):
    DEGRADED = "degraded"
    FAILED = "failed"
    OPERATOR_BLOCKED = "operator_blocked"
    SUCCEEDED = "succeeded"

    def __str__(self) -> str:
        return str(self.value)
