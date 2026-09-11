from enum import Enum


class DeveloperDatabaseStatusNotificationDeliveryLastHeartbeatType0Status(str, Enum):
    DEGRADED = "degraded"
    FAILED = "failed"
    SUCCEEDED = "succeeded"

    def __str__(self) -> str:
        return str(self.value)
