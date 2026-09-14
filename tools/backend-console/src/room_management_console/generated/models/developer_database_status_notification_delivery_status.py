from enum import Enum


class DeveloperDatabaseStatusNotificationDeliveryStatus(str, Enum):
    AWAITING_FIRST_RUN = "awaiting_first_run"
    DEGRADED = "degraded"
    FAILED = "failed"
    HEALTHY = "healthy"

    def __str__(self) -> str:
        return str(self.value)
